/**
 * Repository, file, and branch operations for the github-dev-assistant plugin.
 *
 * Covers:
 *  - github_list_repos  — list user/org repositories
 *  - github_create_repo — create a new repository
 *  - github_get_file    — read file or directory content
 *  - github_update_file — create or update a file with a commit
 *  - github_create_branch — create a new branch from a ref
 */

import { decodeBase64, encodeBase64, validateRequired, validateEnum, clampInt, formatError } from "./utils.js";

/**
 * Format a repository object to a clean, consistent shape.
 * @param {object} r - Raw GitHub repository object
 * @returns {object}
 */
function formatRepo(r) {
  return {
    id: r.id,
    name: r.name,
    full_name: r.full_name,
    description: r.description ?? null,
    private: r.private,
    fork: r.fork,
    url: r.html_url,
    clone_url: r.clone_url,
    ssh_url: r.ssh_url,
    default_branch: r.default_branch,
    language: r.language ?? null,
    stars: r.stargazers_count ?? 0,
    forks: r.forks_count ?? 0,
    open_issues: r.open_issues_count ?? 0,
    size_kb: r.size ?? 0,
    created_at: r.created_at ?? null,
    updated_at: r.updated_at ?? null,
    pushed_at: r.pushed_at ?? null,
    topics: r.topics ?? [],
    license: r.license?.spdx_id ?? null,
    visibility: r.visibility ?? (r.private ? "private" : "public"),
  };
}

/**
 * Build repository operations tools.
 *
 * @param {object} client - GitHub API client (from github-client.js)
 * @param {object} sdk - Teleton plugin SDK (for config and logging)
 * @returns {object[]} Array of tool definitions
 */
export function buildRepoOpsTools(client, sdk) {
  // Resolve owner from params, falling back to plugin config, then authenticated user
  async function resolveOwner(owner) {
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
        "Get a list of GitHub repositories for the authenticated user or a specified owner/organization. " +
        "Returns repository metadata including name, description, language, stars, and visibility.",
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
          const owner = await resolveOwner(params.owner ?? null);
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

          if (!typeVal.valid) return { success: false, error: typeVal.error };
          if (!sortVal.valid) return { success: false, error: sortVal.error };
          if (!directionVal.valid) return { success: false, error: directionVal.error };

          // Determine endpoint: /user/repos for self, /users/:owner/repos or /orgs/:owner/repos
          let path;
          if (!params.owner) {
            path = "/user/repos";
          } else {
            // Try user repos first; org repos have same structure
            path = `/users/${encodeURIComponent(owner)}/repos`;
          }

          const { data, pagination } = await client.getPaginated(path, {
            type: typeVal.value,
            sort: sortVal.value,
            direction: directionVal.value,
            per_page: perPage,
            page,
          });

          const repos = Array.isArray(data) ? data.map(formatRepo) : [];

          sdk.log.info(`github_list_repos: fetched ${repos.length} repos for ${owner}`);

          return {
            success: true,
            data: {
              owner,
              repos,
              count: repos.length,
              pagination,
            },
          };
        } catch (err) {
          return { success: false, error: formatError(err) };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_create_repo
    // -------------------------------------------------------------------------
    {
      name: "github_create_repo",
      description:
        "Create a new GitHub repository. Returns the created repository's URL, ID, and default branch.",
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
          if (!check.valid) return { success: false, error: check.error };

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

          return {
            success: true,
            data: formatRepo(repo),
          };
        } catch (err) {
          return { success: false, error: formatError(err) };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_get_file
    // -------------------------------------------------------------------------
    {
      name: "github_get_file",
      description:
        "Get the content of a file or list a directory from a GitHub repository. " +
        "Returns decoded text content for files, or a list of entries for directories.",
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
          if (!check.valid) return { success: false, error: check.error };

          const queryParams = {};
          if (params.ref) queryParams.ref = params.ref;

          const data = await client.get(
            `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/contents/${params.path}`,
            queryParams
          );

          // Directory listing
          if (Array.isArray(data)) {
            return {
              success: true,
              data: {
                type: "dir",
                path: params.path,
                entries: data.map((e) => ({
                  name: e.name,
                  path: e.path,
                  type: e.type,
                  size: e.size,
                  sha: e.sha,
                  download_url: e.download_url ?? null,
                })),
              },
            };
          }

          // Single file
          const content = data.content ? decodeBase64(data.content) : null;

          sdk.log.info(`github_get_file: read ${data.path} (${data.size} bytes)`);

          return {
            success: true,
            data: {
              type: data.type,
              name: data.name,
              path: data.path,
              sha: data.sha,
              size: data.size,
              content: content,
              encoding: data.encoding ?? "base64",
              html_url: data.html_url ?? null,
              download_url: data.download_url ?? null,
            },
          };
        } catch (err) {
          return { success: false, error: formatError(err) };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_update_file
    // -------------------------------------------------------------------------
    {
      name: "github_update_file",
      description:
        "Create a new file or update an existing file in a GitHub repository with a commit. " +
        "For updates, the current file's SHA (from github_get_file) must be provided. " +
        "Returns the file's new SHA and the commit SHA.",
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
          if (!check.valid) return { success: false, error: check.error };

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

          return {
            success: true,
            data: {
              file_sha: result.content?.sha ?? null,
              file_path: result.content?.path ?? params.path,
              commit_sha: result.commit?.sha ?? null,
              commit_url: result.commit?.html_url ?? null,
              message: params.message,
            },
          };
        } catch (err) {
          return { success: false, error: formatError(err) };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_create_branch
    // -------------------------------------------------------------------------
    {
      name: "github_create_branch",
      description:
        "Create a new branch in a GitHub repository from a specified source ref (branch, tag, or commit SHA). " +
        "Returns the new branch ref and its SHA.",
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
          if (!check.valid) return { success: false, error: check.error };

          const owner = encodeURIComponent(params.owner);
          const repo = encodeURIComponent(params.repo);

          // Resolve the SHA of the source ref
          const fromRef = params.from_ref ?? sdk.pluginConfig?.default_branch ?? "main";
          const refData = await client.get(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(fromRef)}`);
          const sha = refData.object?.sha;
          if (!sha) {
            return {
              success: false,
              error: `Could not resolve SHA for ref: ${fromRef}`,
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

          return {
            success: true,
            data: {
              branch: params.branch,
              sha: result.object?.sha ?? sha,
              ref: result.ref ?? `refs/heads/${params.branch}`,
              source_ref: fromRef,
              source_sha: sha,
            },
          };
        } catch (err) {
          return { success: false, error: formatError(err) };
        }
      },
    },
  ];
}
