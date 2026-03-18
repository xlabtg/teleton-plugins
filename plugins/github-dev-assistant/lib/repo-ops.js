/**
 * Repository, file, and branch operations for the github-dev-assistant plugin.
 *
 * Covers:
 *  - github_list_repos  — list user/org repositories
 *  - github_create_repo — create a new repository
 *  - github_get_file    — read file or directory content
 *  - github_update_file — create or update a file with a commit
 *  - github_create_branch — create a new branch from a ref
 *
 * All tools create a fresh GitHub client per execution to pick up the latest
 * token from sdk.secrets (avoids stale client issues).
 *
 * All tools return { content: string } for direct LLM consumption.
 */

import { createGitHubClient } from "./github-client.js";
import { decodeBase64, encodeBase64, validateRequired, validateEnum, clampInt, formatError } from "./utils.js";

/**
 * Build repository operations tools.
 *
 * @param {object} sdk - Teleton plugin SDK (for config, logging, secrets)
 * @returns {object[]} Array of tool definitions
 */
export function buildRepoOpsTools(sdk) {
  // Resolve owner from params, falling back to plugin config, then authenticated user
  async function resolveOwner(client, owner) {
    if (owner) return owner;
    const configOwner = sdk.pluginConfig?.default_owner ?? null;
    if (configOwner) return configOwner;
    // Fall back to the authenticated user's login
    const user = await client.get("/user");
    return user.login;
  }

  return [
    // -------------------------------------------------------------------------
    // Tool: github_list_repos
    // -------------------------------------------------------------------------
    {
      name: "github_list_repos",
      description:
        "Use this when the user wants to see their GitHub repositories or a list of repos for a user/org. " +
        "Returns a formatted list of repositories with name, description, language, and visibility.",
      category: "data-bearing",
      parameters: {
        type: "object",
        properties: {
          owner: {
            type: "string",
            description:
              "GitHub username or organization name. Omit to use the authenticated user.",
          },
          type: {
            type: "string",
            enum: ["all", "owner", "public", "private", "forks", "sources", "member"],
            description: "Filter by repository type (default: all)",
          },
          sort: {
            type: "string",
            enum: ["created", "updated", "pushed", "full_name"],
            description: "Sort field (default: full_name)",
          },
          direction: {
            type: "string",
            enum: ["asc", "desc"],
            description: "Sort direction (default: asc for full_name, desc otherwise)",
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
      execute: async (params) => {
        try {
          const client = createGitHubClient(sdk);
          const owner = await resolveOwner(client, params.owner ?? null);
          const perPage = clampInt(params.per_page, 1, 100, 30);
          const page = clampInt(params.page, 1, 9999, 1);

          const typeVal = validateEnum(
            params.type,
            ["all", "owner", "public", "private", "forks", "sources", "member"],
            "all"
          );
          const sortVal = validateEnum(
            params.sort,
            ["created", "updated", "pushed", "full_name"],
            "full_name"
          );
          const directionVal = validateEnum(
            params.direction,
            ["asc", "desc"],
            "asc"
          );

          if (!typeVal.valid) return { content: `Error: ${typeVal.error}` };
          if (!sortVal.valid) return { content: `Error: ${sortVal.error}` };
          if (!directionVal.valid) return { content: `Error: ${directionVal.error}` };

          // Determine endpoint: /user/repos for self, /users/:owner/repos or /orgs/:owner/repos
          let path;
          if (!params.owner) {
            path = "/user/repos";
          } else {
            path = `/users/${encodeURIComponent(owner)}/repos`;
          }

          const { data, pagination } = await client.getPaginated(path, {
            type: typeVal.value,
            sort: sortVal.value,
            direction: directionVal.value,
            per_page: perPage,
            page,
          });

          const repos = Array.isArray(data) ? data : [];

          sdk.log.info(`github_list_repos: fetched ${repos.length} repos for ${owner}`);

          if (repos.length === 0) {
            return { content: `No repositories found for ${owner}.` };
          }

          const lines = repos.map((r) => {
            const vis = r.private ? "private" : "public";
            const lang = r.language ? ` [${r.language}]` : "";
            const desc = r.description ? ` — ${r.description}` : "";
            return `- **${r.name}** (${vis})${lang}${desc}`;
          });

          const pageInfo =
            pagination.next
              ? `\n\nPage ${page} of results. Use page=${pagination.next} to get more.`
              : "";

          return {
            content: `Repositories for **${owner}** (${repos.length} shown):\n\n${lines.join("\n")}${pageInfo}`,
          };
        } catch (err) {
          return { content: `Failed to list repositories: ${formatError(err)}` };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_create_repo
    // -------------------------------------------------------------------------
    {
      name: "github_create_repo",
      description:
        "Use this when the user wants to create a new GitHub repository. " +
        "Returns the URL of the newly created repository.",
      category: "action",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Repository name (required, lowercase letters, numbers, hyphens)",
          },
          description: {
            type: "string",
            description: "Short description of the repository",
          },
          private: {
            type: "boolean",
            description: "Create as private repository (default: false)",
          },
          auto_init: {
            type: "boolean",
            description: "Auto-initialize with a README (default: false)",
          },
          license_template: {
            type: "string",
            enum: ["mit", "apache-2.0", "gpl-3.0", "bsd-2-clause", "bsd-3-clause", "mpl-2.0", "lgpl-3.0", "agpl-3.0", "unlicense"],
            description: "License template to apply (optional)",
          },
          gitignore_template: {
            type: "string",
            description: "Gitignore template to use, e.g. 'Node', 'Python' (optional)",
          },
        },
        required: ["name"],
      },
      execute: async (params) => {
        try {
          const check = validateRequired(params, ["name"]);
          if (!check.valid) return { content: `Error: ${check.error}` };

          const client = createGitHubClient(sdk);

          const body = {
            name: params.name,
            private: params.private ?? false,
            auto_init: params.auto_init ?? false,
          };
          if (params.description) body.description = params.description;
          if (params.license_template) body.license_template = params.license_template;
          if (params.gitignore_template) body.gitignore_template = params.gitignore_template;

          const repo = await client.post("/user/repos", body);

          sdk.log.info(`github_create_repo: created ${repo.full_name}`);

          const vis = repo.private ? "private" : "public";
          return {
            content:
              `Repository **${repo.full_name}** created successfully (${vis}).\n` +
              `URL: ${repo.html_url}`,
          };
        } catch (err) {
          return { content: `Failed to create repository: ${formatError(err)}` };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_get_file
    // -------------------------------------------------------------------------
    {
      name: "github_get_file",
      description:
        "Use this when the user wants to read a file or list a directory from a GitHub repository. " +
        "Returns the file content as text, or lists directory entries.",
      category: "data-bearing",
      parameters: {
        type: "object",
        properties: {
          owner: {
            type: "string",
            description: "Repository owner (username or org)",
          },
          repo: {
            type: "string",
            description: "Repository name",
          },
          path: {
            type: "string",
            description: "Path to file or directory within the repo (e.g. 'src/index.js')",
          },
          ref: {
            type: "string",
            description: "Branch, tag, or commit SHA to read from (default: repo default branch)",
          },
        },
        required: ["owner", "repo", "path"],
      },
      execute: async (params) => {
        try {
          const check = validateRequired(params, ["owner", "repo", "path"]);
          if (!check.valid) return { content: `Error: ${check.error}` };

          const client = createGitHubClient(sdk);
          const queryParams = {};
          if (params.ref) queryParams.ref = params.ref;

          const data = await client.get(
            `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/contents/${params.path}`,
            queryParams
          );

          // Directory listing
          if (Array.isArray(data)) {
            const entries = data.map((e) => {
              const icon = e.type === "dir" ? "📁" : "📄";
              return `${icon} ${e.name}${e.type === "dir" ? "/" : ""}`;
            });
            return {
              content:
                `Directory **${params.path}** in ${params.owner}/${params.repo}:\n\n` +
                entries.join("\n"),
            };
          }

          // Single file
          const content = data.content ? decodeBase64(data.content) : null;

          sdk.log.info(`github_get_file: read ${data.path} (${data.size} bytes)`);

          if (!content) {
            return {
              content: `File **${data.path}** exists but has no readable text content (${data.size} bytes).`,
            };
          }

          return {
            content:
              `File **${data.path}** (${data.size} bytes):\n\n\`\`\`\n${content}\n\`\`\``,
          };
        } catch (err) {
          return { content: `Failed to get file: ${formatError(err)}` };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_update_file
    // -------------------------------------------------------------------------
    {
      name: "github_update_file",
      description:
        "Use this when the user wants to create a new file or update an existing file in a GitHub repository. " +
        "For updates, first call github_get_file to get the current SHA. " +
        "Returns the commit URL on success.",
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
          path: {
            type: "string",
            description: "Path to the file within the repo (e.g. 'src/index.js')",
          },
          content: {
            type: "string",
            description: "UTF-8 text content to write to the file",
          },
          message: {
            type: "string",
            description: "Commit message",
          },
          branch: {
            type: "string",
            description: "Branch to commit to (defaults to the repo's default branch)",
          },
          sha: {
            type: "string",
            description: "Current file SHA — required when updating an existing file, omit for new files",
          },
          committer_name: {
            type: "string",
            description: "Committer name (defaults to plugin config commit_author_name)",
          },
          committer_email: {
            type: "string",
            description: "Committer email (defaults to plugin config commit_author_email)",
          },
        },
        required: ["owner", "repo", "path", "content", "message"],
      },
      execute: async (params) => {
        try {
          const check = validateRequired(params, ["owner", "repo", "path", "content", "message"]);
          if (!check.valid) return { content: `Error: ${check.error}` };

          const client = createGitHubClient(sdk);

          const authorName =
            params.committer_name ??
            sdk.pluginConfig?.commit_author_name ??
            "Teleton AI Agent";
          const authorEmail =
            params.committer_email ??
            sdk.pluginConfig?.commit_author_email ??
            "agent@teleton.local";

          const body = {
            message: params.message,
            content: encodeBase64(params.content),
            committer: { name: authorName, email: authorEmail },
          };

          if (params.branch) body.branch = params.branch;
          if (params.sha) body.sha = params.sha;

          const result = await client.put(
            `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/contents/${params.path}`,
            body
          );

          sdk.log.info(
            `github_update_file: committed ${params.path} to ${params.owner}/${params.repo}`
          );

          const action = params.sha ? "updated" : "created";
          const commitUrl = result.commit?.html_url ?? null;
          return {
            content:
              `File **${params.path}** ${action} successfully in ${params.owner}/${params.repo}.\n` +
              `Commit: "${params.message}"` +
              (commitUrl ? `\nURL: ${commitUrl}` : ""),
          };
        } catch (err) {
          return { content: `Failed to update file: ${formatError(err)}` };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_create_branch
    // -------------------------------------------------------------------------
    {
      name: "github_create_branch",
      description:
        "Use this when the user wants to create a new branch in a GitHub repository. " +
        "Returns the new branch name and its starting commit SHA.",
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
          branch: {
            type: "string",
            description: "Name for the new branch",
          },
          from_ref: {
            type: "string",
            description: "Source branch, tag, or commit SHA to branch from (default: repo default branch)",
          },
        },
        required: ["owner", "repo", "branch"],
      },
      execute: async (params) => {
        try {
          const check = validateRequired(params, ["owner", "repo", "branch"]);
          if (!check.valid) return { content: `Error: ${check.error}` };

          const client = createGitHubClient(sdk);
          const owner = encodeURIComponent(params.owner);
          const repo = encodeURIComponent(params.repo);

          // Resolve the SHA of the source ref
          const fromRef = params.from_ref ?? sdk.pluginConfig?.default_branch ?? "main";
          const refData = await client.get(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(fromRef)}`);
          const sha = refData.object?.sha;
          if (!sha) {
            return {
              content: `Failed to create branch: could not resolve source branch "${fromRef}".`,
            };
          }

          // Create the new branch ref
          const result = await client.post(`/repos/${owner}/${repo}/git/refs`, {
            ref: `refs/heads/${params.branch}`,
            sha,
          });

          sdk.log.info(
            `github_create_branch: created ${params.branch} from ${fromRef} in ${params.owner}/${params.repo}`
          );

          const newSha = result.object?.sha ?? sha;
          return {
            content:
              `Branch **${params.branch}** created in ${params.owner}/${params.repo} from \`${fromRef}\`.\n` +
              `SHA: ${newSha.slice(0, 7)}`,
          };
        } catch (err) {
          return { content: `Failed to create branch: ${formatError(err)}` };
        }
      },
    },
  ];
}
