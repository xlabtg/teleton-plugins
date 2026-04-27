/**
 * vk-full-admin - VK personal account and managed community administration.
 *
 * All VK API calls go through vk-io. Tokens are read from sdk.secrets only;
 * storage keeps fingerprints and admin-check metadata, never raw tokens.
 */

import { createHash, randomInt } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { VK } = require("vk-io");
const { groupScopes, userScopes } = require("@vk-io/authorization");

const PLUGIN_ID = "vk-full-admin";
const DEFAULT_API_VERSION = "5.199";
const TOKEN_CACHE_TTL_MS = 50 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RATE_LIMIT_PER_SECOND = 3;
const MAX_ERROR_LENGTH = 500;
const DEFAULT_USER_SCOPES = [
  "offline",
  "wall",
  "messages",
  "friends",
  "photos",
  "groups",
  "stats",
  "notifications",
];
const DEFAULT_GROUP_SCOPES = ["manage", "messages", "photos", "docs"];
const ADMIN_ROLES = new Set(["moderator", "editor", "admin", "administrator", "creator"]);
const ROLE_RANK = {
  none: 0,
  member: 0,
  moderator: 1,
  editor: 2,
  administrator: 3,
  admin: 3,
  creator: 4,
};

export const manifest = {
  name: PLUGIN_ID,
  version: "1.0.0",
  sdkVersion: ">=1.0.0",
  description:
    "VK full administration tools for user profiles and managed communities",
  defaultConfig: {
    api_version: DEFAULT_API_VERSION,
    api_timeout_ms: DEFAULT_TIMEOUT_MS,
    rate_limit_per_second: DEFAULT_RATE_LIMIT_PER_SECOND,
    admin_cache_ttl_ms: TOKEN_CACHE_TTL_MS,
    language: "ru",
  },
  secrets: {
    vk_user_token: {
      required: true,
      env: "VK_FULL_ADMIN_VK_USER_TOKEN",
      description:
        "VK user access token from OAuth implicit flow with wall, messages, friends, photos, groups, stats, notifications, and offline scopes",
    },
    vk_community_tokens: {
      required: false,
      env: "VK_FULL_ADMIN_VK_COMMUNITY_TOKENS",
      description:
        "JSON object mapping community IDs without minus signs to community tokens from VK community API access-token settings",
    },
  },
};

export function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vk_group_cache (
      group_id INTEGER PRIMARY KEY,
      token_hash TEXT,
      admin_checked_at INTEGER,
      last_activity INTEGER
    );

    CREATE TABLE IF NOT EXISTS vk_action_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      group_id INTEGER,
      actor_id INTEGER,
      success INTEGER NOT NULL,
      details TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
}

export const tools = (sdk) => createVkFullAdminTools(sdk);

export function createVkFullAdminTools(sdk, options = {}) {
  const VKClass = options.VKClass ?? VK;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const clientCache = new Map();
  const rateBuckets = new Map();

  const config = {
    apiVersion: sdk?.pluginConfig?.api_version ?? DEFAULT_API_VERSION,
    apiTimeoutMs: Number(sdk?.pluginConfig?.api_timeout_ms ?? DEFAULT_TIMEOUT_MS),
    rateLimitPerSecond: Math.max(
      1,
      Number(sdk?.pluginConfig?.rate_limit_per_second ?? DEFAULT_RATE_LIMIT_PER_SECOND)
    ),
    adminCacheTtlMs: Number(sdk?.pluginConfig?.admin_cache_ttl_ms ?? TOKEN_CACHE_TTL_MS),
    language: sdk?.pluginConfig?.language ?? "ru",
  };

  async function storageGet(key) {
    try {
      return await sdk?.storage?.get?.(key);
    } catch (err) {
      sdk?.log?.debug?.(`vk storage get failed for ${key}: ${String(err.message || err)}`);
      return undefined;
    }
  }

  async function storageSet(key, value, opts) {
    try {
      await sdk?.storage?.set?.(key, value, opts);
    } catch (err) {
      sdk?.log?.debug?.(`vk storage set failed for ${key}: ${String(err.message || err)}`);
    }
  }

  async function storageDelete(key) {
    try {
      await sdk?.storage?.delete?.(key);
    } catch (err) {
      sdk?.log?.debug?.(`vk storage delete failed for ${key}: ${String(err.message || err)}`);
    }
  }

  async function getSecret(name, { required = true } = {}) {
    const secrets = sdk?.secrets;
    let value;
    if (required && typeof secrets?.require === "function") {
      value = await secrets.require(name);
    } else if (typeof secrets?.get === "function") {
      value = await secrets.get(name);
    }

    if (required && !value) {
      throw new Error(`${name} is required. Add it in Teleton plugin secrets.`);
    }
    return value ?? null;
  }

  async function loadUserToken() {
    return String(await getSecret("vk_user_token"));
  }

  async function loadCommunityTokens({ required = true } = {}) {
    const raw = await getSecret("vk_community_tokens", { required });
    if (!raw) return {};
    if (typeof raw === "object") return normalizeCommunityTokenMap(raw);
    try {
      return normalizeCommunityTokenMap(JSON.parse(String(raw)));
    } catch {
      throw new Error("vk_community_tokens must be a JSON object like {\"123456\":\"token\"}.");
    }
  }

  function normalizeCommunityTokenMap(raw) {
    if (!raw || Array.isArray(raw) || typeof raw !== "object") {
      throw new Error("vk_community_tokens must be a JSON object keyed by community ID.");
    }

    const normalized = {};
    for (const [key, value] of Object.entries(raw)) {
      if (!value) continue;
      const groupId = Math.abs(Number(key));
      if (!Number.isSafeInteger(groupId) || groupId <= 0) continue;
      normalized[String(groupId)] = String(value);
    }
    return normalized;
  }

  async function loadCommunityToken(groupId) {
    const tokens = await loadCommunityTokens();
    const token = tokens[String(groupId)];
    if (!token) {
      throw new Error(`No VK community token configured for group ${groupId}.`);
    }
    return token;
  }

  async function getVkSession(kind, id, token) {
    const tokenHash = hashToken(token);
    const cacheKey = `${kind}:${id}:${tokenHash}`;
    const cached = clientCache.get(cacheKey);
    if (cached && cached.expiresAt > now()) return cached.session;

    const client = new VKClass({
      token,
      apiVersion: config.apiVersion,
      apiLimit: config.rateLimitPerSecond,
      apiTimeout: config.apiTimeoutMs,
      language: config.language,
    });

    const session = { client, tokenHash, token };
    clientCache.set(cacheKey, {
      session,
      expiresAt: now() + TOKEN_CACHE_TTL_MS,
    });

    await storageSet(
      `vk:token:${kind}:${id}`,
      { token_hash: tokenHash, cached_at: now() },
      { ttl: TOKEN_CACHE_TTL_MS }
    );
    return session;
  }

  async function getUserSession() {
    return getVkSession("user", "self", await loadUserToken());
  }

  async function getCommunitySession(groupId) {
    return getVkSession("community", groupId, await loadCommunityToken(groupId));
  }

  async function getCurrentUserId(userSession) {
    const cacheKey = `vk:user:self:${userSession.tokenHash}`;
    const cached = await storageGet(cacheKey);
    if (cached?.id) return cached.id;

    const users = await callVk(userSession, "users.get", {});
    const id = Array.isArray(users) ? users[0]?.id : users?.id;
    if (!Number.isSafeInteger(Number(id))) {
      throw new Error("Could not determine VK user ID from vk_user_token.");
    }
    const userId = Number(id);
    await storageSet(cacheKey, { id: userId }, { ttl: TOKEN_CACHE_TTL_MS });
    return userId;
  }

  async function waitRateLimit(tokenHash) {
    const limit = config.rateLimitPerSecond;
    const key = `rate:${tokenHash}`;

    while (true) {
      const current = now();
      const bucket = (rateBuckets.get(key) ?? []).filter((ts) => current - ts < 1000);
      if (bucket.length < limit) {
        bucket.push(current);
        rateBuckets.set(key, bucket);
        return;
      }

      const waitMs = Math.max(1, 1000 - (current - bucket[0]) + 5);
      rateBuckets.set(key, bucket);
      await sleep(waitMs);
    }
  }

  async function callVk(session, method, params = {}, { retryRateLimit = true } = {}) {
    await waitRateLimit(session.tokenHash);
    try {
      return await session.client.api.call(method, cleanParams(params));
    } catch (err) {
      if (getVkErrorCode(err) === 260 && retryRateLimit) {
        sdk?.log?.warn?.(`VK rate limit for ${method}; retrying once.`);
        await sleep(1000);
        return callVk(session, method, params, { retryRateLimit: false });
      }
      if (getVkErrorCode(err) === 5) {
        clearTokenHash(session.tokenHash);
      }
      throw err;
    }
  }

  async function uploadVk(session, uploadMethod, params = {}) {
    await waitRateLimit(session.tokenHash);
    try {
      const upload = session.client.upload?.[uploadMethod];
      if (typeof upload !== "function") {
        throw new Error(`vk-io upload method ${uploadMethod} is not available.`);
      }
      return await upload.call(session.client.upload, cleanParams(params));
    } catch (err) {
      if (getVkErrorCode(err) === 5) clearTokenHash(session.tokenHash);
      throw err;
    }
  }

  function clearTokenHash(tokenHash) {
    for (const [key, value] of clientCache.entries()) {
      if (value.session.tokenHash === tokenHash) clientCache.delete(key);
    }
    void storageDelete(`vk:invalid:${tokenHash}`);
  }

  async function assertGroupAdmin(groupId, { minRole = "moderator" } = {}) {
    const userSession = await getUserSession();
    const userId = await getCurrentUserId(userSession);
    const cacheKey = `vk:admin:${userId}:${groupId}`;
    const cached = await storageGet(cacheKey);
    if (cached?.role && isRoleAllowed(cached.role, minRole)) return cached;

    const member = await callVk(userSession, "groups.isMember", {
      group_id: groupId,
      user_id: userId,
      extended: 1,
    });
    let role = roleFromAdminPayload(member);

    if (!isRoleAllowed(role, minRole)) {
      const groupInfo = await callVk(userSession, "groups.getById", {
        group_ids: String(groupId),
        fields: "is_admin,admin_level,manager_role",
      });
      role = roleFromAdminPayload(Array.isArray(groupInfo) ? groupInfo[0] : groupInfo?.groups?.[0]);
    }

    if (!isRoleAllowed(role, minRole)) {
      throw new Error(
        `Insufficient rights in community ${groupId}. Required role: ${minRole}; detected role: ${role}.`
      );
    }

    const result = { group_id: groupId, user_id: userId, role, checked_at: now() };
    await storageSet(cacheKey, result, { ttl: config.adminCacheTtlMs });
    cacheGroupAdminCheck(groupId, userSession.tokenHash);
    return result;
  }

  function cacheGroupAdminCheck(groupId, tokenHash) {
    try {
      sdk?.db
        ?.prepare(
          `INSERT INTO vk_group_cache (group_id, token_hash, admin_checked_at, last_activity)
           VALUES (?, ?, unixepoch(), unixepoch())
           ON CONFLICT(group_id) DO UPDATE SET
             token_hash = excluded.token_hash,
             admin_checked_at = excluded.admin_checked_at,
             last_activity = excluded.last_activity`
        )
        .run(groupId, tokenHash);
    } catch (err) {
      sdk?.log?.debug?.(`vk group cache write failed: ${String(err.message || err)}`);
    }
  }

  async function communityAction(groupId, { minRole = "moderator" } = {}) {
    const admin = await assertGroupAdmin(groupId, { minRole });
    const communitySession = await getCommunitySession(groupId);
    return { admin, communitySession };
  }

  async function executeTool(action, handler, { groupId = null, actorId = null } = {}) {
    try {
      const data = await handler();
      auditAction(action, { groupId, actorId, success: true });
      return { success: true, data };
    } catch (err) {
      auditAction(action, {
        groupId,
        actorId,
        success: false,
        details: sanitizeError(err),
      });
      sdk?.log?.warn?.(`${action} failed: ${sanitizeError(err)}`);
      return { success: false, error: formatVkError(err) };
    }
  }

  function auditAction(action, { groupId = null, actorId = null, success, details = null } = {}) {
    try {
      sdk?.db
        ?.prepare(
          `INSERT INTO vk_action_audit (action, group_id, actor_id, success, details)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(action, groupId, actorId, success ? 1 : 0, details);
    } catch (err) {
      sdk?.log?.debug?.(`vk audit write failed: ${String(err.message || err)}`);
    }
  }

  return [
    {
      name: "vk_auth_status",
      description:
        "Check whether VK user and community tokens are configured. Optionally validates the user token through VK users.get.",
      scope: "admin-only",
      category: "data-bearing",
      parameters: {
        type: "object",
        properties: {
          validate: {
            type: "boolean",
            description: "When true, call VK users.get to validate vk_user_token.",
            default: false,
          },
        },
      },
      execute: async (params) => executeTool("vk_auth_status", async () => {
        const userToken = await getSecret("vk_user_token", { required: false });
        const communityTokens = await loadCommunityTokens({ required: false });
        const data = {
          user_token_configured: Boolean(userToken),
          community_token_group_ids: Object.keys(communityTokens).map(Number).sort((a, b) => a - b),
          community_token_count: Object.keys(communityTokens).length,
          default_user_scopes: DEFAULT_USER_SCOPES,
          default_group_scopes: DEFAULT_GROUP_SCOPES,
        };

        if (params.validate && userToken) {
          const session = await getVkSession("user", "self", String(userToken));
          const users = await callVk(session, "users.get", {});
          data.user = Array.isArray(users) ? users[0] : users;
        }
        return data;
      }),
    },
    {
      name: "vk_auth_user_url",
      description:
        "Build a VK OAuth implicit-flow URL for obtaining vk_user_token. No network request is made and no token is stored.",
      scope: "admin-only",
      category: "data-bearing",
      parameters: {
        type: "object",
        properties: {
          client_id: { type: "string", description: "VK application client ID." },
          redirect_uri: {
            type: "string",
            description: "OAuth redirect URI registered in VK app settings.",
            default: "https://oauth.vk.com/blank.html",
          },
          scopes: {
            type: "array",
            description: "VK user scope names. Defaults cover this plugin.",
            items: { type: "string" },
          },
          revoke: {
            type: "boolean",
            description: "Force VK to ask for permissions again.",
            default: false,
          },
        },
        required: ["client_id"],
      },
      execute: async (params) => executeTool("vk_auth_user_url", async () => {
        const scopes = params.scopes?.length ? params.scopes : DEFAULT_USER_SCOPES;
        return {
          url: buildOAuthUrl({
            clientId: params.client_id,
            redirectUri: params.redirect_uri,
            scope: scopeMask(scopes, userScopes),
            revoke: params.revoke,
          }),
          scopes,
          flow: "implicit_user",
          store_as_secret: "vk_user_token",
        };
      }),
    },
    {
      name: "vk_auth_group_url",
      description:
        "Build a VK OAuth URL for obtaining community tokens for selected groups. No network request is made and no token is stored.",
      scope: "admin-only",
      category: "data-bearing",
      parameters: {
        type: "object",
        properties: {
          client_id: { type: "string", description: "VK application client ID." },
          group_ids: {
            type: "array",
            description: "Community IDs without minus sign.",
            items: { type: "integer" },
          },
          redirect_uri: {
            type: "string",
            description: "OAuth redirect URI registered in VK app settings.",
            default: "https://oauth.vk.com/blank.html",
          },
          scopes: {
            type: "array",
            description: "VK community scope names. Defaults cover group administration.",
            items: { type: "string" },
          },
          revoke: { type: "boolean", description: "Force permission confirmation.", default: false },
        },
        required: ["client_id", "group_ids"],
      },
      execute: async (params) => executeTool("vk_auth_group_url", async () => {
        const scopes = params.scopes?.length ? params.scopes : DEFAULT_GROUP_SCOPES;
        return {
          url: buildOAuthUrl({
            clientId: params.client_id,
            redirectUri: params.redirect_uri,
            scope: scopeMask(scopes, groupScopes),
            groupIds: params.group_ids,
            revoke: params.revoke,
          }),
          scopes,
          flow: "implicit_group",
          store_as_secret: "vk_community_tokens",
        };
      }),
    },
    {
      name: "vk_group_admin_check",
      description:
        "Validate that vk_user_token belongs to a moderator, editor, administrator, or creator of a VK community.",
      scope: "admin-only",
      category: "data-bearing",
      parameters: {
        type: "object",
        properties: {
          group_id: { type: "integer", description: "Community ID without minus sign." },
          min_role: {
            type: "string",
            enum: ["moderator", "editor", "admin"],
            description: "Minimum role required for the check.",
            default: "moderator",
          },
        },
        required: ["group_id"],
      },
      execute: async (params) => executeTool("vk_group_admin_check", async () => {
        const admin = await assertGroupAdmin(Number(params.group_id), {
          minRole: normalizeRequestedRole(params.min_role ?? "moderator"),
        });
        const communityTokens = await loadCommunityTokens({ required: false });
        return {
          ...admin,
          community_token_configured: Boolean(communityTokens[String(Math.abs(Number(params.group_id)))]),
        };
      }, { groupId: Number(params.group_id) }),
    },
    buildUserInfoTool(),
    buildUserMessagesSendTool(),
    buildUserWallPostTool(),
    buildUserFriendsListTool(),
    buildGroupWallPostTool(),
    buildGroupWallEditTool(),
    buildGroupWallDeleteTool(),
    buildGroupPinPostTool(),
    buildGroupUploadPhotoTool(),
    buildGroupCreatePollTool(),
    buildGroupCommentDeleteTool(),
    buildGroupCommentHideSpamTool(),
    buildGroupBanUserTool(),
    buildGroupUnbanUserTool(),
    buildGroupBlacklistListTool(),
    buildGroupCleanWallTool(),
    buildGroupMembersListTool(),
    buildGroupInviteTool(),
    buildGroupRemoveTool(),
    buildGroupSetRoleTool(),
    buildGroupInfoTool(),
    buildGroupUpdateSettingsTool(),
    buildGroupUpdateCoverTool(),
    buildGroupUpdateAvatarTool(),
    buildGroupStatsTool(),
    buildGroupPostReachTool(),
    buildGroupAudienceTool(),
    buildGroupMsgSendTool(),
    buildGroupMsgHistoryTool(),
    buildGroupMsgSetTypingTool(),
  ];

  function buildUserInfoTool() {
    return {
      name: "vk_user_info",
      description:
        "Get VK user profile data including status, online state, screen name, and optional fields.",
      scope: "admin-only",
      category: "data-bearing",
      parameters: {
        type: "object",
        properties: {
          user_ids: {
            type: "array",
            description: "VK user IDs or screen names. Omit for the token owner.",
            items: { type: "string" },
          },
          fields: {
            type: "array",
            description: "VK users.get fields.",
            items: { type: "string" },
          },
        },
      },
      execute: async (params) => executeTool("vk_user_info", async () => {
        const session = await getUserSession();
        const data = await callVk(session, "users.get", {
          user_ids: normalizeList(params.user_ids).join(",") || undefined,
          fields: normalizeList(params.fields, [
            "photo_200",
            "screen_name",
            "online",
            "status",
            "city",
            "country",
            "bdate",
          ]).join(","),
        });
        return { users: data };
      }),
    };
  }

  function buildUserMessagesSendTool() {
    return {
      name: "vk_user_messages_send",
      description:
        "Send a VK direct message from the user account to user_id or peer_id. Uses random_id for idempotency.",
      scope: "dm-only",
      category: "action",
      parameters: {
        type: "object",
        properties: {
          user_id: { type: "integer", description: "Recipient user ID." },
          peer_id: { type: "integer", description: "Recipient peer ID for chats or users." },
          message: { type: "string", description: "Message text." },
          attachment: { type: "string", description: "Optional VK attachment string." },
          random_id: { type: "integer", description: "Optional idempotency key." },
        },
        required: ["message"],
      },
      execute: async (params) => executeTool("vk_user_messages_send", async () => {
        const session = await getUserSession();
        const response = await callVk(session, "messages.send", {
          user_id: params.user_id,
          peer_id: params.peer_id,
          message: params.message,
          attachment: params.attachment,
          random_id: params.random_id ?? randomId(),
        });
        sdk?.log?.info?.("VK user message sent.");
        return { response };
      }),
    };
  }

  function buildUserWallPostTool() {
    return {
      name: "vk_user_wall_post",
      description:
        "Publish a post on the VK user's wall or a user-managed owner_id using vk_user_token.",
      scope: "admin-only",
      category: "action",
      parameters: {
        type: "object",
        properties: {
          owner_id: { type: "integer", description: "Optional wall owner ID. Omit for own wall." },
          message: { type: "string", description: "Post text." },
          attachments: { type: "string", description: "Optional VK attachment string." },
          signed: { type: "boolean", description: "Sign the post when supported.", default: false },
        },
        required: ["message"],
      },
      execute: async (params) => executeTool("vk_user_wall_post", async () => {
        const session = await getUserSession();
        const response = await callVk(session, "wall.post", {
          owner_id: params.owner_id,
          message: params.message,
          attachments: params.attachments,
          signed: boolFlag(params.signed),
        });
        sdk?.log?.info?.("VK user wall post created.");
        return { response };
      }),
    };
  }

  function buildUserFriendsListTool() {
    return {
      name: "vk_user_friends_list",
      description: "List VK friends for the token owner or another visible user.",
      scope: "admin-only",
      category: "data-bearing",
      parameters: {
        type: "object",
        properties: {
          user_id: { type: "integer", description: "Optional VK user ID." },
          fields: { type: "array", items: { type: "string" }, description: "Friend fields." },
          order: { type: "string", description: "VK friends.get order, for example name or hints." },
          count: { type: "integer", description: "Maximum number of friends to return.", minimum: 1, maximum: 5000 },
          offset: { type: "integer", description: "Pagination offset.", minimum: 0 },
        },
      },
      execute: async (params) => executeTool("vk_user_friends_list", async () => {
        const session = await getUserSession();
        const response = await callVk(session, "friends.get", {
          user_id: params.user_id,
          fields: normalizeList(params.fields).join(",") || undefined,
          order: params.order,
          count: params.count,
          offset: params.offset,
        });
        return { friends: response };
      }),
    };
  }

  function buildGroupWallPostTool() {
    return {
      name: "vk_group_wall_post",
      description:
        "Publish a post on a managed VK community wall. Requires Editor/Admin rights and a community token.",
      scope: "admin-only",
      category: "action",
      parameters: {
        type: "object",
        properties: {
          owner_id: { type: "integer", description: "Negative community owner ID, for example -123456." },
          group_id: { type: "integer", description: "Alternative community ID without minus sign." },
          message: { type: "string", description: "Post text up to VK limits." },
          attachments: { type: "string", description: "Optional VK attachment string." },
          publish_date: { type: "integer", description: "Unix timestamp for scheduled publication." },
          close_comments: { type: "boolean", description: "Disable comments when VK allows it.", default: false },
          signed: { type: "boolean", description: "Sign post with administrator name.", default: false },
        },
        required: ["message"],
      },
      execute: async (params) => {
        const { groupId, ownerId } = normalizeGroupOwner(params);
        return executeTool("vk_group_wall_post", async () => {
          const { communitySession, admin } = await communityAction(groupId, { minRole: "editor" });
          const response = await callVk(communitySession, "wall.post", {
            owner_id: ownerId,
            from_group: 1,
            message: params.message,
            attachments: params.attachments,
            publish_date: params.publish_date,
            close_comments: boolFlag(params.close_comments),
            signed: boolFlag(params.signed),
          });
          sdk?.log?.info?.(`VK group ${groupId} wall post created.`);
          return { group_id: groupId, owner_id: ownerId, admin_role: admin.role, response };
        }, { groupId });
      },
    };
  }

  function buildGroupWallEditTool() {
    return {
      name: "vk_group_wall_edit",
      description: "Edit a post on a managed VK community wall. Requires Editor/Admin rights.",
      scope: "admin-only",
      category: "action",
      parameters: {
        type: "object",
        properties: {
          owner_id: { type: "integer", description: "Negative community owner ID." },
          group_id: { type: "integer", description: "Alternative community ID without minus sign." },
          post_id: { type: "integer", description: "Post ID." },
          message: { type: "string", description: "Updated post text." },
          attachments: { type: "string", description: "Updated VK attachment string." },
        },
        required: ["post_id"],
      },
      execute: async (params) => {
        const { groupId, ownerId } = normalizeGroupOwner(params);
        return executeTool("vk_group_wall_edit", async () => {
          const { communitySession } = await communityAction(groupId, { minRole: "editor" });
          const response = await callVk(communitySession, "wall.edit", {
            owner_id: ownerId,
            post_id: params.post_id,
            message: params.message,
            attachments: params.attachments,
          });
          return { group_id: groupId, owner_id: ownerId, post_id: params.post_id, response };
        }, { groupId });
      },
    };
  }

  function buildGroupWallDeleteTool() {
    return {
      name: "vk_group_wall_delete",
      description: "Delete a post or repost from a managed VK community wall.",
      scope: "admin-only",
      category: "action",
      parameters: {
        type: "object",
        properties: {
          owner_id: { type: "integer", description: "Negative community owner ID." },
          group_id: { type: "integer", description: "Alternative community ID without minus sign." },
          post_id: { type: "integer", description: "Post ID to delete." },
        },
        required: ["post_id"],
      },
      execute: async (params) => {
        const { groupId, ownerId } = normalizeGroupOwner(params);
        return executeTool("vk_group_wall_delete", async () => {
          const { communitySession } = await communityAction(groupId, { minRole: "editor" });
          const response = await callVk(communitySession, "wall.delete", {
            owner_id: ownerId,
            post_id: params.post_id,
          });
          return { group_id: groupId, owner_id: ownerId, post_id: params.post_id, response };
        }, { groupId });
      },
    };
  }

  function buildGroupPinPostTool() {
    return {
      name: "vk_group_pin_post",
      description: "Pin or unpin a post on a managed VK community wall.",
      scope: "admin-only",
      category: "action",
      parameters: {
        type: "object",
        properties: {
          owner_id: { type: "integer", description: "Negative community owner ID." },
          group_id: { type: "integer", description: "Alternative community ID without minus sign." },
          post_id: { type: "integer", description: "Post ID." },
          pin: { type: "boolean", description: "true to pin, false to unpin.", default: true },
        },
        required: ["post_id", "pin"],
      },
      execute: async (params) => {
        const { groupId, ownerId } = normalizeGroupOwner(params);
        return executeTool("vk_group_pin_post", async () => {
          const { communitySession } = await communityAction(groupId, { minRole: "editor" });
          const method = params.pin ? "wall.pin" : "wall.unpin";
          const response = await callVk(communitySession, method, {
            owner_id: ownerId,
            post_id: params.post_id,
          });
          return { group_id: groupId, owner_id: ownerId, post_id: params.post_id, pinned: Boolean(params.pin), response };
        }, { groupId });
      },
    };
  }

  function buildGroupUploadPhotoTool() {
    return {
      name: "vk_group_upload_photo",
      description: "Upload a photo to a VK community wall or album using vk-io upload helpers.",
      scope: "admin-only",
      category: "action",
      parameters: {
        type: "object",
        properties: {
          owner_id: { type: "integer", description: "Negative community owner ID." },
          group_id: { type: "integer", description: "Alternative community ID without minus sign." },
          file_path: { type: "string", description: "Local image path accessible to Teleton." },
          album_id: { type: "integer", description: "Optional album ID. Omit to upload wall photo." },
          caption: { type: "string", description: "Optional photo caption." },
        },
        required: ["file_path"],
      },
      execute: async (params) => {
        const { groupId } = normalizeGroupOwner(params);
        return executeTool("vk_group_upload_photo", async () => {
          const { communitySession } = await communityAction(groupId, { minRole: "editor" });
          const source = { value: params.file_path };
          const result = params.album_id
            ? await uploadVk(communitySession, "photoAlbum", {
              group_id: groupId,
              album_id: params.album_id,
              caption: params.caption,
              source,
            })
            : await uploadVk(communitySession, "wallPhoto", {
              group_id: groupId,
              caption: params.caption,
              source,
            });
          return {
            group_id: groupId,
            attachment: Array.isArray(result) ? result.map(attachmentToString) : attachmentToString(result),
            raw: result,
          };
        }, { groupId });
      },
    };
  }

  function buildGroupCreatePollTool() {
    return {
      name: "vk_group_create_poll",
      description: "Create a VK poll owned by a managed community.",
      scope: "admin-only",
      category: "action",
      parameters: {
        type: "object",
        properties: {
          owner_id: { type: "integer", description: "Negative community owner ID." },
          group_id: { type: "integer", description: "Alternative community ID without minus sign." },
          question: { type: "string", description: "Poll question." },
          options: {
            type: "array",
            description: "Poll answer options.",
            items: { type: "string" },
            minItems: 2,
          },
          anonymous: { type: "boolean", description: "Create an anonymous poll.", default: true },
          is_multiple: { type: "boolean", description: "Allow multiple choices.", default: false },
          end_date: { type: "integer", description: "Unix timestamp when poll closes." },
        },
        required: ["question", "options"],
      },
      execute: async (params) => {
        const { groupId, ownerId } = normalizeGroupOwner(params);
        return executeTool("vk_group_create_poll", async () => {
          const { communitySession } = await communityAction(groupId, { minRole: "editor" });
          const response = await callVk(communitySession, "polls.create", {
            owner_id: ownerId,
            question: params.question,
            add_answers: JSON.stringify(params.options ?? []),
            is_anonymous: params.anonymous === false ? 0 : 1,
            is_multiple: boolFlag(params.is_multiple),
            end_date: params.end_date,
          });
          return { group_id: groupId, owner_id: ownerId, response };
        }, { groupId });
      },
    };
  }

  function buildGroupCommentDeleteTool() {
    return {
      name: "vk_group_comment_delete",
      description: "Delete a comment from a managed VK community wall.",
      scope: "admin-only",
      category: "action",
      parameters: {
        type: "object",
        properties: {
          owner_id: { type: "integer", description: "Negative community owner ID." },
          group_id: { type: "integer", description: "Alternative community ID without minus sign." },
          comment_id: { type: "integer", description: "Comment ID to delete." },
        },
        required: ["comment_id"],
      },
      execute: async (params) => {
        const { groupId, ownerId } = normalizeGroupOwner(params);
        return executeTool("vk_group_comment_delete", async () => {
          const { communitySession } = await communityAction(groupId);
          const response = await callVk(communitySession, "wall.deleteComment", {
            owner_id: ownerId,
            comment_id: params.comment_id,
          });
          return { group_id: groupId, owner_id: ownerId, comment_id: params.comment_id, response };
        }, { groupId });
      },
    };
  }

  function buildGroupCommentHideSpamTool() {
    return {
      name: "vk_group_comment_hide_spam",
      description: "Report a VK community wall comment as spam or another moderation reason.",
      scope: "admin-only",
      category: "action",
      parameters: {
        type: "object",
        properties: {
          owner_id: { type: "integer", description: "Negative community owner ID." },
          group_id: { type: "integer", description: "Alternative community ID without minus sign." },
          comment_id: { type: "integer", description: "Comment ID." },
          reason: {
            type: "integer",
            description: "VK report reason code. 0 is spam.",
            default: 0,
          },
        },
        required: ["comment_id"],
      },
      execute: async (params) => {
        const { groupId, ownerId } = normalizeGroupOwner(params);
        return executeTool("vk_group_comment_hide_spam", async () => {
          const { communitySession } = await communityAction(groupId);
          const response = await callVk(communitySession, "wall.reportComment", {
            owner_id: ownerId,
            comment_id: params.comment_id,
            reason: params.reason ?? 0,
          });
          return { group_id: groupId, owner_id: ownerId, comment_id: params.comment_id, response };
        }, { groupId });
      },
    };
  }

  function buildGroupBanUserTool() {
    return {
      name: "vk_group_ban_user",
      description: "Ban a user or guest from a managed VK community.",
      scope: "admin-only",
      category: "action",
      parameters: {
        type: "object",
        properties: {
          group_id: { type: "integer", description: "Community ID without minus sign." },
          user_id: { type: "integer", description: "User ID to ban." },
          comment: { type: "string", description: "Optional private moderation comment." },
          end_date: { type: "integer", description: "Unix timestamp for temporary ban end." },
          reason: { type: "integer", description: "VK ban reason code." },
          comment_visible: { type: "boolean", description: "Show comment to banned user.", default: false },
        },
        required: ["group_id", "user_id"],
      },
      execute: async (params) => executeTool("vk_group_ban_user", async () => {
        const groupId = Math.abs(Number(params.group_id));
        const { communitySession } = await communityAction(groupId);
        const response = await callVk(communitySession, "groups.ban", {
          group_id: groupId,
          owner_id: params.user_id,
          comment: params.comment,
          end_date: params.end_date,
          reason: params.reason,
          comment_visible: boolFlag(params.comment_visible),
        });
        return { group_id: groupId, user_id: params.user_id, response };
      }, { groupId: Math.abs(Number(params.group_id)) }),
    };
  }

  function buildGroupUnbanUserTool() {
    return {
      name: "vk_group_unban_user",
      description: "Remove a user or guest from a VK community blacklist.",
      scope: "admin-only",
      category: "action",
      parameters: {
        type: "object",
        properties: {
          group_id: { type: "integer", description: "Community ID without minus sign." },
          user_id: { type: "integer", description: "User ID to unban." },
        },
        required: ["group_id", "user_id"],
      },
      execute: async (params) => executeTool("vk_group_unban_user", async () => {
        const groupId = Math.abs(Number(params.group_id));
        const { communitySession } = await communityAction(groupId);
        const response = await callVk(communitySession, "groups.unban", {
          group_id: groupId,
          owner_id: params.user_id,
        });
        return { group_id: groupId, user_id: params.user_id, response };
      }, { groupId: Math.abs(Number(params.group_id)) }),
    };
  }

  function buildGroupBlacklistListTool() {
    return {
      name: "vk_group_blacklist_list",
      description: "List banned users for a managed VK community.",
      scope: "admin-only",
      category: "data-bearing",
      parameters: {
        type: "object",
        properties: {
          group_id: { type: "integer", description: "Community ID without minus sign." },
          offset: { type: "integer", description: "Pagination offset.", minimum: 0 },
          count: { type: "integer", description: "Number of banned entries.", minimum: 1, maximum: 200 },
        },
        required: ["group_id"],
      },
      execute: async (params) => executeTool("vk_group_blacklist_list", async () => {
        const groupId = Math.abs(Number(params.group_id));
        await assertGroupAdmin(groupId);
        const session = await getUserSession();
        const response = await callVk(session, "groups.getBanned", {
          group_id: groupId,
          offset: params.offset,
          count: params.count ?? 20,
        });
        return { group_id: groupId, banned: response };
      }, { groupId: Math.abs(Number(params.group_id)) }),
    };
  }

  function buildGroupCleanWallTool() {
    return {
      name: "vk_group_clean_wall",
      description:
        "Find and optionally delete multiple VK community wall posts. Defaults to dry_run=true for safety.",
      scope: "admin-only",
      category: "action",
      parameters: {
        type: "object",
        properties: {
          owner_id: { type: "integer", description: "Negative community owner ID." },
          group_id: { type: "integer", description: "Alternative community ID without minus sign." },
          filter: {
            type: "string",
            description: "all, owner, others, or contains. contains uses query.",
            enum: ["all", "owner", "others", "contains"],
            default: "all",
          },
          query: { type: "string", description: "Text substring for filter=contains." },
          count: { type: "integer", description: "Maximum posts to inspect/delete.", minimum: 1, maximum: 100 },
          dry_run: { type: "boolean", description: "When true, only return matching posts.", default: true },
        },
      },
      execute: async (params) => {
        const { groupId, ownerId } = normalizeGroupOwner(params);
        return executeTool("vk_group_clean_wall", async () => {
          const { communitySession } = await communityAction(groupId, { minRole: "editor" });
          const requestedCount = clamp(Number(params.count ?? 20), 1, 100);
          const wall = await callVk(communitySession, "wall.get", {
            owner_id: ownerId,
            count: requestedCount,
          });
          const posts = Array.isArray(wall?.items) ? wall.items : [];
          const matches = posts
            .filter((post) => matchesCleanFilter(post, ownerId, params.filter ?? "all", params.query))
            .slice(0, requestedCount);

          if (params.dry_run !== false) {
            return {
              group_id: groupId,
              owner_id: ownerId,
              dry_run: true,
              matched_count: matches.length,
              posts: matches.map(compactPost),
            };
          }

          const deleted = [];
          for (const post of matches) {
            const response = await callVk(communitySession, "wall.delete", {
              owner_id: ownerId,
              post_id: post.id,
            });
            deleted.push({ post_id: post.id, response });
          }
          return { group_id: groupId, owner_id: ownerId, dry_run: false, deleted };
        }, { groupId });
      },
    };
  }

  function buildGroupMembersListTool() {
    return {
      name: "vk_group_members_list",
      description: "List members or subscribers of a managed VK community.",
      scope: "admin-only",
      category: "data-bearing",
      parameters: {
        type: "object",
        properties: {
          group_id: { type: "integer", description: "Community ID without minus sign." },
          sort: { type: "string", description: "VK sorting mode." },
          count: { type: "integer", description: "Number of members.", minimum: 1, maximum: 1000 },
          offset: { type: "integer", description: "Pagination offset.", minimum: 0 },
          fields: { type: "array", items: { type: "string" }, description: "Member fields." },
        },
        required: ["group_id"],
      },
      execute: async (params) => executeTool("vk_group_members_list", async () => {
        const groupId = Math.abs(Number(params.group_id));
        await assertGroupAdmin(groupId);
        const session = await getUserSession();
        const response = await callVk(session, "groups.getMembers", {
          group_id: groupId,
          sort: params.sort,
          count: params.count ?? 100,
          offset: params.offset,
          fields: normalizeList(params.fields).join(",") || undefined,
        });
        return { group_id: groupId, members: response };
      }, { groupId: Math.abs(Number(params.group_id)) }),
    };
  }

  function buildGroupInviteTool() {
    return {
      name: "vk_group_invite",
      description: "Invite a VK user to a managed community.",
      scope: "admin-only",
      category: "action",
      parameters: {
        type: "object",
        properties: {
          group_id: { type: "integer", description: "Community ID without minus sign." },
          user_id: { type: "integer", description: "User ID to invite." },
          text: { type: "string", description: "Optional note returned in tool output." },
        },
        required: ["group_id", "user_id"],
      },
      execute: async (params) => executeTool("vk_group_invite", async () => {
        const groupId = Math.abs(Number(params.group_id));
        await assertGroupAdmin(groupId, { minRole: "editor" });
        const session = await getUserSession();
        const response = await callVk(session, "groups.invite", {
          group_id: groupId,
          user_id: params.user_id,
        });
        return { group_id: groupId, user_id: params.user_id, note: params.text ?? null, response };
      }, { groupId: Math.abs(Number(params.group_id)) }),
    };
  }

  function buildGroupRemoveTool() {
    return {
      name: "vk_group_remove",
      description: "Remove a user from a managed VK community.",
      scope: "admin-only",
      category: "action",
      parameters: {
        type: "object",
        properties: {
          group_id: { type: "integer", description: "Community ID without minus sign." },
          user_id: { type: "integer", description: "User ID to remove." },
          message: { type: "string", description: "Optional note returned in tool output." },
        },
        required: ["group_id", "user_id"],
      },
      execute: async (params) => executeTool("vk_group_remove", async () => {
        const groupId = Math.abs(Number(params.group_id));
        const { communitySession } = await communityAction(groupId);
        const response = await callVk(communitySession, "groups.removeUser", {
          group_id: groupId,
          user_id: params.user_id,
        });
        return { group_id: groupId, user_id: params.user_id, note: params.message ?? null, response };
      }, { groupId: Math.abs(Number(params.group_id)) }),
    };
  }

  function buildGroupSetRoleTool() {
    return {
      name: "vk_group_set_role",
      description: "Assign or remove a community manager role. Requires administrator rights.",
      scope: "admin-only",
      category: "action",
      parameters: {
        type: "object",
        properties: {
          group_id: { type: "integer", description: "Community ID without minus sign." },
          user_id: { type: "integer", description: "User ID whose role will change." },
          role: {
            type: "string",
            enum: ["admin", "editor", "moderator", "none"],
            description: "Target role. admin maps to VK administrator.",
          },
        },
        required: ["group_id", "user_id", "role"],
      },
      execute: async (params) => executeTool("vk_group_set_role", async () => {
        const groupId = Math.abs(Number(params.group_id));
        await assertGroupAdmin(groupId, { minRole: "admin" });
        const session = await getUserSession();
        const response = await callVk(session, "groups.editManager", {
          group_id: groupId,
          user_id: params.user_id,
          role: vkManagerRole(params.role),
        });
        return { group_id: groupId, user_id: params.user_id, role: params.role, response };
      }, { groupId: Math.abs(Number(params.group_id)) }),
    };
  }

  function buildGroupInfoTool() {
    return {
      name: "vk_group_info",
      description: "Get information for one or more VK communities after validating admin rights.",
      scope: "admin-only",
      category: "data-bearing",
      parameters: {
        type: "object",
        properties: {
          group_ids: {
            type: "array",
            description: "Community IDs without minus sign. First ID is used for admin validation.",
            items: { type: "integer" },
          },
          fields: {
            type: "array",
            description: "VK groups.getById fields.",
            items: { type: "string" },
          },
        },
        required: ["group_ids"],
      },
      execute: async (params) => executeTool("vk_group_info", async () => {
        const groupIds = normalizeList(params.group_ids).map((id) => Math.abs(Number(id))).filter(Boolean);
        if (!groupIds.length) throw new Error("group_ids must contain at least one community ID.");
        await assertGroupAdmin(groupIds[0]);
        const session = await getUserSession();
        const response = await callVk(session, "groups.getById", {
          group_ids: groupIds.join(","),
          fields: normalizeList(params.fields, [
            "description",
            "members_count",
            "activity",
            "status",
            "site",
            "is_admin",
            "admin_level",
          ]).join(","),
        });
        return { groups: response };
      }, { groupId: Number(normalizeList(params.group_ids)[0]) }),
    };
  }

  function buildGroupUpdateSettingsTool() {
    return {
      name: "vk_group_update_settings",
      description: "Update managed VK community settings such as title, description, type, or access.",
      scope: "admin-only",
      category: "action",
      parameters: {
        type: "object",
        properties: {
          group_id: { type: "integer", description: "Community ID without minus sign." },
          title: { type: "string", description: "New community title." },
          description: { type: "string", description: "New community description." },
          type: { type: "string", enum: ["group", "event", "public"], description: "Community type." },
          access: { type: "integer", description: "VK access mode." },
          website: { type: "string", description: "Community website URL." },
        },
        required: ["group_id"],
      },
      execute: async (params) => executeTool("vk_group_update_settings", async () => {
        const groupId = Math.abs(Number(params.group_id));
        const { communitySession } = await communityAction(groupId, { minRole: "admin" });
        const response = await callVk(communitySession, "groups.edit", {
          group_id: groupId,
          title: params.title,
          description: params.description,
          type: params.type,
          access: params.access,
          website: params.website,
        });
        return { group_id: groupId, response };
      }, { groupId: Math.abs(Number(params.group_id)) }),
    };
  }

  function buildGroupUpdateCoverTool() {
    return {
      name: "vk_group_update_cover",
      description: "Upload and set the cover image for a managed VK community.",
      scope: "admin-only",
      category: "action",
      parameters: {
        type: "object",
        properties: {
          group_id: { type: "integer", description: "Community ID without minus sign." },
          file_path: { type: "string", description: "Local cover image path." },
          crop_x: { type: "integer", description: "Optional crop start X." },
          crop_y: { type: "integer", description: "Optional crop start Y." },
          crop_x2: { type: "integer", description: "Optional crop end X." },
          crop_y2: { type: "integer", description: "Optional crop end Y." },
        },
        required: ["group_id", "file_path"],
      },
      execute: async (params) => executeTool("vk_group_update_cover", async () => {
        const groupId = Math.abs(Number(params.group_id));
        const { communitySession } = await communityAction(groupId, { minRole: "admin" });
        const response = await uploadVk(communitySession, "groupCover", {
          group_id: groupId,
          source: { value: params.file_path },
          crop_x: params.crop_x,
          crop_y: params.crop_y,
          crop_x2: params.crop_x2,
          crop_y2: params.crop_y2,
        });
        return { group_id: groupId, response };
      }, { groupId: Math.abs(Number(params.group_id)) }),
    };
  }

  function buildGroupUpdateAvatarTool() {
    return {
      name: "vk_group_update_avatar",
      description: "Upload and set the main avatar photo for a managed VK community.",
      scope: "admin-only",
      category: "action",
      parameters: {
        type: "object",
        properties: {
          group_id: { type: "integer", description: "Community ID without minus sign." },
          file_path: { type: "string", description: "Local image path." },
        },
        required: ["group_id", "file_path"],
      },
      execute: async (params) => executeTool("vk_group_update_avatar", async () => {
        const groupId = Math.abs(Number(params.group_id));
        const { communitySession } = await communityAction(groupId, { minRole: "admin" });
        const response = await uploadVk(communitySession, "ownerPhoto", {
          owner_id: -groupId,
          source: { value: params.file_path },
        });
        return { group_id: groupId, response };
      }, { groupId: Math.abs(Number(params.group_id)) }),
    };
  }

  function buildGroupStatsTool() {
    return {
      name: "vk_group_stats",
      description: "Get VK community statistics for a period.",
      scope: "admin-only",
      category: "data-bearing",
      parameters: {
        type: "object",
        properties: {
          group_id: { type: "integer", description: "Community ID without minus sign." },
          interval: { type: "string", enum: ["day", "week", "month"], description: "VK stats interval." },
          stats_groups: { type: "array", items: { type: "string" }, description: "Stats groups such as visitors or reach." },
          date_from: { type: "string", description: "Start date YYYY-MM-DD or Unix timestamp." },
          date_to: { type: "string", description: "End date YYYY-MM-DD or Unix timestamp." },
        },
        required: ["group_id"],
      },
      execute: async (params) => executeTool("vk_group_stats", async () => {
        const groupId = Math.abs(Number(params.group_id));
        const { communitySession } = await communityAction(groupId, { minRole: "editor" });
        const response = await callVk(communitySession, "stats.get", {
          group_id: groupId,
          interval: params.interval ?? "day",
          stats_groups: normalizeList(params.stats_groups).join(",") || undefined,
          timestamp_from: parseDateOrTimestamp(params.date_from),
          timestamp_to: parseDateOrTimestamp(params.date_to),
        });
        return { group_id: groupId, stats: response };
      }, { groupId: Math.abs(Number(params.group_id)) }),
    };
  }

  function buildGroupPostReachTool() {
    return {
      name: "vk_group_post_reach",
      description: "Get reach and engagement statistics for VK community posts.",
      scope: "admin-only",
      category: "data-bearing",
      parameters: {
        type: "object",
        properties: {
          owner_id: { type: "integer", description: "Negative community owner ID." },
          group_id: { type: "integer", description: "Alternative community ID without minus sign." },
          post_ids: {
            type: "array",
            description: "Post IDs to inspect.",
            items: { type: "integer" },
          },
        },
        required: ["post_ids"],
      },
      execute: async (params) => {
        const { groupId, ownerId } = normalizeGroupOwner(params);
        return executeTool("vk_group_post_reach", async () => {
          const { communitySession } = await communityAction(groupId, { minRole: "editor" });
          const response = await callVk(communitySession, "wall.getPostReach", {
            owner_id: ownerId,
            post_ids: normalizeList(params.post_ids).join(","),
          });
          return { group_id: groupId, owner_id: ownerId, reach: response };
        }, { groupId });
      },
    };
  }

  function buildGroupAudienceTool() {
    return {
      name: "vk_group_audience",
      description: "Get VK community audience visitor demographics for a period.",
      scope: "admin-only",
      category: "data-bearing",
      parameters: {
        type: "object",
        properties: {
          group_id: { type: "integer", description: "Community ID without minus sign." },
          date_from: { type: "string", description: "Start date YYYY-MM-DD or Unix timestamp." },
          date_to: { type: "string", description: "End date YYYY-MM-DD or Unix timestamp." },
        },
        required: ["group_id"],
      },
      execute: async (params) => executeTool("vk_group_audience", async () => {
        const groupId = Math.abs(Number(params.group_id));
        const { communitySession } = await communityAction(groupId, { minRole: "editor" });
        const response = await callVk(communitySession, "stats.get", {
          group_id: groupId,
          interval: "day",
          stats_groups: "visitors",
          timestamp_from: parseDateOrTimestamp(params.date_from),
          timestamp_to: parseDateOrTimestamp(params.date_to),
        });
        return { group_id: groupId, audience: response };
      }, { groupId: Math.abs(Number(params.group_id)) }),
    };
  }

  function buildGroupMsgSendTool() {
    return {
      name: "vk_group_msg_send",
      description: "Send a VK message from a managed community to a peer.",
      scope: "admin-only",
      category: "action",
      parameters: {
        type: "object",
        properties: {
          group_id: { type: "integer", description: "Community ID without minus sign." },
          peer_id: { type: "integer", description: "VK peer ID." },
          message: { type: "string", description: "Message text." },
          random_id: { type: "integer", description: "Optional idempotency key." },
          attachment: { type: "string", description: "Optional VK attachment string." },
          keyboard: { type: "string", description: "Optional VK keyboard JSON string." },
        },
        required: ["group_id", "peer_id", "message"],
      },
      execute: async (params) => executeTool("vk_group_msg_send", async () => {
        const groupId = Math.abs(Number(params.group_id));
        const { communitySession } = await communityAction(groupId);
        const response = await callVk(communitySession, "messages.send", {
          group_id: groupId,
          peer_id: params.peer_id,
          message: params.message,
          random_id: params.random_id ?? randomId(),
          attachment: params.attachment,
          keyboard: params.keyboard,
        });
        return { group_id: groupId, peer_id: params.peer_id, response };
      }, { groupId: Math.abs(Number(params.group_id)) }),
    };
  }

  function buildGroupMsgHistoryTool() {
    return {
      name: "vk_group_msg_history",
      description: "Read message history for a VK community dialog.",
      scope: "admin-only",
      category: "data-bearing",
      parameters: {
        type: "object",
        properties: {
          group_id: { type: "integer", description: "Community ID without minus sign." },
          peer_id: { type: "integer", description: "VK peer ID." },
          count: { type: "integer", description: "Number of messages.", minimum: 1, maximum: 200 },
          offset: { type: "integer", description: "Pagination offset.", minimum: 0 },
        },
        required: ["group_id", "peer_id"],
      },
      execute: async (params) => executeTool("vk_group_msg_history", async () => {
        const groupId = Math.abs(Number(params.group_id));
        const { communitySession } = await communityAction(groupId);
        const response = await callVk(communitySession, "messages.getHistory", {
          group_id: groupId,
          peer_id: params.peer_id,
          count: params.count ?? 20,
          offset: params.offset,
        });
        return { group_id: groupId, peer_id: params.peer_id, history: response };
      }, { groupId: Math.abs(Number(params.group_id)) }),
    };
  }

  function buildGroupMsgSetTypingTool() {
    return {
      name: "vk_group_msg_set_typing",
      description: "Set typing or videocall activity in a VK community dialog.",
      scope: "admin-only",
      category: "action",
      parameters: {
        type: "object",
        properties: {
          group_id: { type: "integer", description: "Community ID without minus sign." },
          peer_id: { type: "integer", description: "VK peer ID." },
          type: {
            type: "string",
            enum: ["typing", "videocall"],
            description: "Activity type.",
            default: "typing",
          },
        },
        required: ["group_id", "peer_id"],
      },
      execute: async (params) => executeTool("vk_group_msg_set_typing", async () => {
        const groupId = Math.abs(Number(params.group_id));
        const { communitySession } = await communityAction(groupId);
        const response = await callVk(communitySession, "messages.setActivity", {
          group_id: groupId,
          peer_id: params.peer_id,
          type: params.type ?? "typing",
        });
        return { group_id: groupId, peer_id: params.peer_id, type: params.type ?? "typing", response };
      }, { groupId: Math.abs(Number(params.group_id)) }),
    };
  }
}

function hashToken(token) {
  return createHash("sha256").update(String(token)).digest("hex").slice(0, 16);
}

function cleanParams(params) {
  const cleaned = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null && value !== "") cleaned[key] = value;
  }
  return cleaned;
}

function getVkErrorCode(err) {
  return Number(err?.code ?? err?.error_code ?? err?.error?.error_code ?? 0);
}

function sanitizeError(err) {
  let message = String(err?.message ?? err?.error_msg ?? err?.error?.error_msg ?? err);
  message = message.replace(/(access_token=)[^\s&]+/gi, "$1[redacted]");
  message = message.replace(/("access_token"\s*:\s*")[^"]+(")/gi, "$1[redacted]$2");
  message = message.replace(/(token=)[^\s&]+/gi, "$1[redacted]");
  return message.slice(0, MAX_ERROR_LENGTH);
}

function formatVkError(err) {
  const code = getVkErrorCode(err);
  const message = sanitizeError(err);
  if (code === 5) {
    return `VK API error 5: invalid or expired access token. Update vk_user_token or vk_community_tokens. ${message}`;
  }
  if (code === 7 || code === 15) {
    return `VK API error ${code}: access denied or insufficient permissions. ${message}`;
  }
  if (code === 260) {
    return `VK API error 260: rate limit exceeded. ${message}`;
  }
  return message;
}

function normalizeGroupOwner(params) {
  const rawGroup = params.group_id ?? params.owner_id;
  if (rawGroup === undefined || rawGroup === null) {
    throw new Error("group_id or owner_id is required for community tools.");
  }
  const groupId = Math.abs(Number(rawGroup));
  if (!Number.isSafeInteger(groupId) || groupId <= 0) {
    throw new Error("group_id/owner_id must resolve to a positive community ID.");
  }
  return { groupId, ownerId: -groupId };
}

function roleFromAdminPayload(payload) {
  const item = Array.isArray(payload) ? payload[0] : payload;
  if (!item || item.member === 0) return "none";

  const managerRole = normalizeRoleName(item.manager_role ?? item.role);
  if (ADMIN_ROLES.has(managerRole)) return managerRole;

  const adminLevel = Number(item.admin_level ?? item.level ?? 0);
  if (adminLevel >= 3) return "admin";
  if (adminLevel === 2) return "editor";
  if (adminLevel === 1) return "moderator";
  if (item.is_admin === 1 || item.is_admin === true) return "admin";
  return item.member === 1 || item.member === true ? "member" : "none";
}

function normalizeRoleName(role) {
  const value = String(role ?? "none").toLowerCase();
  if (value === "administrator") return "admin";
  return value;
}

function normalizeRequestedRole(role) {
  const normalized = normalizeRoleName(role);
  return normalized === "administrator" ? "admin" : normalized;
}

function isRoleAllowed(actualRole, requiredRole) {
  return (ROLE_RANK[normalizeRoleName(actualRole)] ?? 0) >= (ROLE_RANK[normalizeRequestedRole(requiredRole)] ?? 0);
}

function normalizeList(value, fallback = []) {
  if (value === undefined || value === null || value === "") return fallback;
  if (Array.isArray(value)) return value.filter((item) => item !== undefined && item !== null && item !== "");
  return [value];
}

function boolFlag(value) {
  return value ? 1 : undefined;
}

function randomId() {
  return randomInt(1, 2_147_483_647);
}

function scopeMask(scopes, scopeMap) {
  let mask = 0;
  for (const scope of normalizeList(scopes)) {
    const value = scopeMap.get(String(scope));
    if (!value) throw new Error(`Unknown VK scope: ${scope}`);
    mask |= value;
  }
  return String(mask);
}

function buildOAuthUrl({ clientId, redirectUri, scope, groupIds, revoke = false }) {
  const url = new URL("https://oauth.vk.com/authorize");
  url.searchParams.set("client_id", String(clientId));
  url.searchParams.set("display", "page");
  url.searchParams.set("redirect_uri", redirectUri ?? "https://oauth.vk.com/blank.html");
  url.searchParams.set("scope", String(scope));
  url.searchParams.set("response_type", "token");
  url.searchParams.set("v", DEFAULT_API_VERSION);
  if (groupIds?.length) {
    url.searchParams.set("group_ids", normalizeList(groupIds).map((id) => Math.abs(Number(id))).join(","));
  }
  if (revoke) url.searchParams.set("revoke", "1");
  return url.toString();
}

function attachmentToString(attachment) {
  if (!attachment) return null;
  if (typeof attachment === "string") return attachment;
  if (typeof attachment.toString === "function") return attachment.toString();
  const ownerId = attachment.owner_id ?? attachment.ownerId;
  const id = attachment.id;
  const accessKey = attachment.access_key ?? attachment.accessKey;
  if (ownerId && id) return `photo${ownerId}_${id}${accessKey ? `_${accessKey}` : ""}`;
  return attachment;
}

function matchesCleanFilter(post, ownerId, filter, query) {
  if (filter === "all") return true;
  if (filter === "owner") return Number(post.from_id) === ownerId;
  if (filter === "others") return Number(post.from_id) !== ownerId;
  if (filter === "contains") {
    const needle = String(query ?? "").toLowerCase();
    if (!needle) return false;
    return String(post.text ?? "").toLowerCase().includes(needle);
  }
  return false;
}

function compactPost(post) {
  return {
    id: post.id,
    from_id: post.from_id,
    date: post.date,
    text: String(post.text ?? "").slice(0, 300),
  };
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function parseDateOrTimestamp(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (/^\d+$/.test(String(value))) return Number(value);
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(timestamp)) throw new Error(`Invalid date: ${value}`);
  return Math.floor(timestamp / 1000);
}

function vkManagerRole(role) {
  if (role === "none") return undefined;
  if (role === "admin") return "administrator";
  return role;
}
