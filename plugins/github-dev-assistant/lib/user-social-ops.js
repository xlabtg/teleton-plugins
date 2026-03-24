/**
 * User, social, and gist operations for the github-dev-assistant plugin.
 *
 * Covers:
 *  - github_get_me               — get authenticated user profile
 *  - github_search_users         — search GitHub users
 *  - github_list_notifications   — list GitHub notifications
 *  - github_star_repo            — star a repository
 *  - github_unstar_repo          — unstar a repository
 *  - github_list_gists           — list gists for a user
 *  - github_get_gist             — get a specific gist
 *  - github_create_gist          — create a new gist
 *
 * All tools create a fresh GitHub client per execution to pick up the latest
 * token from sdk.secrets (avoids stale client issues).
 *
 * All tools return { success, data?, error? } per the SDK ToolResult contract.
 */

import { createGitHubClient } from "./github-client.js";
import { validateRequired, clampInt, formatError } from "./utils.js";

/**
 * Build user, social, and gist tools.
 *
 * @param {object} sdk - Teleton plugin SDK (for config, logging, secrets)
 * @returns {object[]} Array of tool definitions
 */
export function buildUserSocialOpsTools(sdk) {
  return [
    // -------------------------------------------------------------------------
    // Tool: github_get_me
    // -------------------------------------------------------------------------
    {
      name: "github_get_me",
      description:
        "Use this when the user wants to see the authenticated GitHub user's profile information. " +
        "Returns username, name, email, followers, and other public profile data.",
      category: "data-bearing",
      parameters: {
        type: "object",
        properties: {},
      },
      execute: async (_params, _context) => {
        try {
          const client = createGitHubClient(sdk);
          const user = await client.get("/user");

          sdk.log.info(`github_get_me: fetched profile for @${user?.login}`);

          return {
            success: true,
            data: {
              login: user?.login ?? null,
              name: user?.name ?? null,
              email: user?.email ?? null,
              bio: user?.bio ?? null,
              company: user?.company ?? null,
              location: user?.location ?? null,
              blog: user?.blog ?? null,
              public_repos: user?.public_repos ?? 0,
              public_gists: user?.public_gists ?? 0,
              followers: user?.followers ?? 0,
              following: user?.following ?? 0,
              html_url: user?.html_url ?? null,
              avatar_url: user?.avatar_url ?? null,
              created_at: user?.created_at ?? null,
            },
          };
        } catch (err) {
          return { success: false, error: `Failed to get user profile: ${formatError(err)}` };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_search_users
    // -------------------------------------------------------------------------
    {
      name: "github_search_users",
      description:
        "Use this when the user wants to search for GitHub users or organizations. " +
        "Supports GitHub user search qualifiers (e.g. 'location:london language:python'). " +
        "Returns matching users with their login, name, and profile URL.",
      category: "data-bearing",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query (e.g. 'john location:london repos:>10')",
          },
          sort: {
            type: "string",
            enum: ["followers", "repositories", "joined"],
            description: "Sort field (default: best match)",
          },
          order: {
            type: "string",
            enum: ["asc", "desc"],
            description: "Sort direction (default: desc)",
          },
          per_page: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description: "Results per page (1-100, default: 30)",
          },
          page: {
            type: "integer",
            minimum: 1,
            description: "Page number (default: 1)",
          },
        },
        required: ["query"],
      },
      execute: async (params, _context) => {
        try {
          const check = validateRequired(params, ["query"]);
          if (!check.valid) return { success: false, error: check.error };

          const client = createGitHubClient(sdk);
          const perPage = clampInt(params.per_page, 1, 100, 30);
          const page = clampInt(params.page, 1, 9999, 1);

          const queryParams = { q: params.query, per_page: perPage, page };
          if (params.sort) queryParams.sort = params.sort;
          if (params.order) queryParams.order = params.order;

          const { data, pagination } = await client.getPaginated("/search/users", queryParams);

          const items = Array.isArray(data?.items) ? data.items : [];

          sdk.log.info(
            `github_search_users: found ${data?.total_count ?? 0} users for "${params.query}"`
          );

          const results = items.map((u) => ({
            login: u.login,
            type: u.type ?? "User",
            html_url: u.html_url,
            avatar_url: u.avatar_url ?? null,
          }));

          return {
            success: true,
            data: {
              query: params.query,
              total_count: data?.total_count ?? 0,
              results,
              count: results.length,
              next_page: pagination.next ?? null,
            },
          };
        } catch (err) {
          return { success: false, error: `Failed to search users: ${formatError(err)}` };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_list_notifications
    // -------------------------------------------------------------------------
    {
      name: "github_list_notifications",
      description:
        "Use this when the user wants to see their GitHub notifications (mentions, reviews, subscriptions). " +
        "Returns unread or all notifications with their type and repository.",
      category: "data-bearing",
      parameters: {
        type: "object",
        properties: {
          all: {
            type: "boolean",
            description: "If true, include already-read notifications (default: false = only unread)",
          },
          participating: {
            type: "boolean",
            description: "If true, only include notifications from conversations the user is participating in",
          },
          per_page: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description: "Results per page (1-100, default: 30)",
          },
          page: {
            type: "integer",
            minimum: 1,
            description: "Page number (default: 1)",
          },
        },
      },
      execute: async (params, _context) => {
        try {
          const client = createGitHubClient(sdk);
          const perPage = clampInt(params.per_page, 1, 100, 30);
          const page = clampInt(params.page, 1, 9999, 1);

          const queryParams = { per_page: perPage, page };
          if (params.all !== undefined) queryParams.all = params.all;
          if (params.participating !== undefined) queryParams.participating = params.participating;

          const { data, pagination } = await client.getPaginated("/notifications", queryParams);

          const notifications = Array.isArray(data) ? data : [];

          sdk.log.info(`github_list_notifications: fetched ${notifications.length} notifications`);

          const notifList = notifications.map((n) => ({
            id: n.id,
            unread: n.unread,
            reason: n.reason,
            type: n.subject?.type ?? null,
            title: n.subject?.title ?? null,
            repo: n.repository?.full_name ?? null,
            updated_at: n.updated_at,
            url: n.subject?.url ?? null,
          }));

          return {
            success: true,
            data: {
              notifications: notifList,
              count: notifList.length,
              next_page: pagination.next ?? null,
            },
          };
        } catch (err) {
          return { success: false, error: `Failed to list notifications: ${formatError(err)}` };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_star_repo
    // -------------------------------------------------------------------------
    {
      name: "github_star_repo",
      description:
        "Use this when the user wants to star a GitHub repository. " +
        "Returns a confirmation on success.",
      category: "action",
      parameters: {
        type: "object",
        properties: {
          owner: {
            type: "string",
            description: "Repository owner",
          },
          repo: {
            type: "string",
            description: "Repository name",
          },
        },
        required: ["owner", "repo"],
      },
      execute: async (params, _context) => {
        try {
          const check = validateRequired(params, ["owner", "repo"]);
          if (!check.valid) return { success: false, error: check.error };

          const client = createGitHubClient(sdk);

          await client.put(
            `/user/starred/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}`,
            {}
          );

          sdk.log.info(`github_star_repo: starred ${params.owner}/${params.repo}`);

          return {
            success: true,
            data: {
              repo: `${params.owner}/${params.repo}`,
              message: `Successfully starred ${params.owner}/${params.repo}.`,
            },
          };
        } catch (err) {
          return { success: false, error: `Failed to star repository: ${formatError(err)}` };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_unstar_repo
    // -------------------------------------------------------------------------
    {
      name: "github_unstar_repo",
      description:
        "Use this when the user wants to unstar a GitHub repository. " +
        "Returns a confirmation on success.",
      category: "action",
      parameters: {
        type: "object",
        properties: {
          owner: {
            type: "string",
            description: "Repository owner",
          },
          repo: {
            type: "string",
            description: "Repository name",
          },
        },
        required: ["owner", "repo"],
      },
      execute: async (params, _context) => {
        try {
          const check = validateRequired(params, ["owner", "repo"]);
          if (!check.valid) return { success: false, error: check.error };

          const client = createGitHubClient(sdk);

          await client.delete(
            `/user/starred/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}`
          );

          sdk.log.info(`github_unstar_repo: unstarred ${params.owner}/${params.repo}`);

          return {
            success: true,
            data: {
              repo: `${params.owner}/${params.repo}`,
              message: `Successfully unstarred ${params.owner}/${params.repo}.`,
            },
          };
        } catch (err) {
          return { success: false, error: `Failed to unstar repository: ${formatError(err)}` };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_list_gists
    // -------------------------------------------------------------------------
    {
      name: "github_list_gists",
      description:
        "Use this when the user wants to list gists for a GitHub user or the authenticated user. " +
        "Returns gist IDs, descriptions, and file names.",
      category: "data-bearing",
      parameters: {
        type: "object",
        properties: {
          username: {
            type: "string",
            description: "GitHub username to list gists for (defaults to authenticated user)",
          },
          per_page: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description: "Results per page (1-100, default: 30)",
          },
          page: {
            type: "integer",
            minimum: 1,
            description: "Page number (default: 1)",
          },
        },
      },
      execute: async (params, _context) => {
        try {
          const client = createGitHubClient(sdk);
          const perPage = clampInt(params.per_page, 1, 100, 30);
          const page = clampInt(params.page, 1, 9999, 1);

          const apiPath = params.username
            ? `/users/${encodeURIComponent(params.username)}/gists`
            : "/gists";

          const { data, pagination } = await client.getPaginated(apiPath, { per_page: perPage, page });

          const gists = Array.isArray(data) ? data : [];

          sdk.log.info(`github_list_gists: fetched ${gists.length} gists`);

          const gistList = gists.map((g) => ({
            id: g.id,
            description: g.description || null,
            public: g.public,
            files: Object.keys(g.files ?? {}),
            html_url: g.html_url,
            created_at: g.created_at,
            updated_at: g.updated_at,
          }));

          return {
            success: true,
            data: {
              username: params.username ?? "authenticated user",
              gists: gistList,
              count: gistList.length,
              next_page: pagination.next ?? null,
            },
          };
        } catch (err) {
          return { success: false, error: `Failed to list gists: ${formatError(err)}` };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_get_gist
    // -------------------------------------------------------------------------
    {
      name: "github_get_gist",
      description:
        "Use this when the user wants to read the content of a specific GitHub gist. " +
        "Returns the gist files with their content.",
      category: "data-bearing",
      parameters: {
        type: "object",
        properties: {
          gist_id: {
            type: "string",
            description: "The gist ID (from github_list_gists or the URL)",
          },
        },
        required: ["gist_id"],
      },
      execute: async (params, _context) => {
        try {
          const check = validateRequired(params, ["gist_id"]);
          if (!check.valid) return { success: false, error: check.error };

          const client = createGitHubClient(sdk);

          const gist = await client.get(`/gists/${encodeURIComponent(params.gist_id)}`);

          sdk.log.info(`github_get_gist: fetched gist ${params.gist_id}`);

          const files = Object.entries(gist?.files ?? {}).map(([name, f]) => ({
            filename: f.filename ?? name,
            language: f.language ?? null,
            size: f.size ?? 0,
            content: f.content ?? null,
          }));

          return {
            success: true,
            data: {
              id: gist?.id ?? params.gist_id,
              description: gist?.description || null,
              public: gist?.public ?? false,
              owner: gist?.owner?.login ?? null,
              html_url: gist?.html_url ?? null,
              created_at: gist?.created_at ?? null,
              updated_at: gist?.updated_at ?? null,
              files,
            },
          };
        } catch (err) {
          return { success: false, error: `Failed to get gist: ${formatError(err)}` };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_create_gist
    // -------------------------------------------------------------------------
    {
      name: "github_create_gist",
      description:
        "Use this when the user wants to create a new GitHub gist with one or more files. " +
        "Returns the created gist's ID and URL.",
      category: "action",
      parameters: {
        type: "object",
        properties: {
          description: {
            type: "string",
            description: "Description of the gist",
          },
          public: {
            type: "boolean",
            description: "Whether the gist is public (default: false = secret)",
          },
          files: {
            type: "array",
            description: "Array of files to include in the gist",
            items: {
              type: "object",
              properties: {
                filename: { type: "string", description: "File name (including extension)" },
                content: { type: "string", description: "File content" },
              },
              required: ["filename", "content"],
            },
          },
        },
        required: ["files"],
      },
      execute: async (params, _context) => {
        try {
          const check = validateRequired(params, ["files"]);
          if (!check.valid) return { success: false, error: check.error };

          if (!Array.isArray(params.files) || params.files.length === 0) {
            return { success: false, error: "files must be a non-empty array" };
          }

          // Build the files object expected by GitHub API
          const filesObj = {};
          for (const f of params.files) {
            if (!f.filename || !f.content) {
              return { success: false, error: `Each file must have 'filename' and 'content'. Invalid entry: ${JSON.stringify(f)}` };
            }
            filesObj[f.filename] = { content: f.content };
          }

          const client = createGitHubClient(sdk);

          const body = {
            files: filesObj,
            public: params.public ?? false,
          };
          if (params.description) body.description = params.description;

          const gist = await client.post("/gists", body);

          sdk.log.info(`github_create_gist: created gist ${gist?.id}`);

          return {
            success: true,
            data: {
              id: gist?.id ?? null,
              description: gist?.description || null,
              public: gist?.public ?? false,
              html_url: gist?.html_url ?? null,
              files: Object.keys(gist?.files ?? {}),
              message: `Gist created successfully at ${gist?.html_url}.`,
            },
          };
        } catch (err) {
          return { success: false, error: `Failed to create gist: ${formatError(err)}` };
        }
      },
    },
  ];
}
