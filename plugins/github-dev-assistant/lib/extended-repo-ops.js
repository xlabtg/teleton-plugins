/**
 * Extended repository operations for the github-dev-assistant plugin.
 *
 * Covers:
 *  - github_fork_repo        — fork a repository
 *  - github_search_repos     — search GitHub repositories
 *  - github_list_branches    — list branches in a repository
 *  - github_push_files       — push multiple files in a single commit
 *  - github_get_repo_tree    — get the full repository file tree
 *  - github_list_tags        — list repository tags
 *  - github_list_releases    — list repository releases
 *  - github_get_latest_release — get the latest release
 *
 * All tools create a fresh GitHub client per execution to pick up the latest
 * token from sdk.secrets (avoids stale client issues).
 *
 * All tools return { success, data?, error? } per the SDK ToolResult contract.
 */

import { createGitHubClient } from "./github-client.js";
import { validateRequired, clampInt, formatError } from "./utils.js";

/**
 * Build extended repository operation tools.
 *
 * @param {object} sdk - Teleton plugin SDK (for config, logging, secrets)
 * @returns {object[]} Array of tool definitions
 */
export function buildExtendedRepoOpsTools(sdk) {
  return [
    // -------------------------------------------------------------------------
    // Tool: github_fork_repo
    // -------------------------------------------------------------------------
    {
      name: "github_fork_repo",
      description:
        "Use this when the user wants to fork a GitHub repository into their account or an organization. " +
        "Returns the forked repository details.",
      category: "action",
      parameters: {
        type: "object",
        properties: {
          owner: {
            type: "string",
            description: "Owner of the repository to fork",
          },
          repo: {
            type: "string",
            description: "Repository name to fork",
          },
          organization: {
            type: "string",
            description: "Optional: fork into this organization instead of the authenticated user's account",
          },
        },
        required: ["owner", "repo"],
      },
      execute: async (params, _context) => {
        try {
          const check = validateRequired(params, ["owner", "repo"]);
          if (!check.valid) return { success: false, error: check.error };

          const client = createGitHubClient(sdk);
          const body = {};
          if (params.organization) body.organization = params.organization;

          const result = await client.post(
            `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/forks`,
            body
          );

          sdk.log.info(
            `github_fork_repo: forked ${params.owner}/${params.repo} → ${result?.full_name}`
          );

          return {
            success: true,
            data: {
              full_name: result?.full_name ?? null,
              html_url: result?.html_url ?? null,
              clone_url: result?.clone_url ?? null,
              default_branch: result?.default_branch ?? null,
              parent: `${params.owner}/${params.repo}`,
              message: `Repository forked successfully as ${result?.full_name}.`,
            },
          };
        } catch (err) {
          return { success: false, error: `Failed to fork repository: ${formatError(err)}` };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_search_repos
    // -------------------------------------------------------------------------
    {
      name: "github_search_repos",
      description:
        "Use this when the user wants to search GitHub for repositories matching a query. " +
        "Supports GitHub search qualifiers (e.g. 'language:javascript stars:>1000'). " +
        "Returns a list of matching repositories with stars, forks, and description.",
      category: "data-bearing",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query (e.g. 'machine learning language:python stars:>100')",
          },
          sort: {
            type: "string",
            enum: ["stars", "forks", "help-wanted-issues", "updated"],
            description: "Sort order (default: best match)",
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

          const { data, pagination } = await client.getPaginated("/search/repositories", queryParams);

          const items = Array.isArray(data?.items) ? data.items : [];

          sdk.log.info(
            `github_search_repos: found ${data?.total_count ?? 0} repos for query "${params.query}"`
          );

          const results = items.map((r) => ({
            full_name: r.full_name,
            description: r.description ?? null,
            html_url: r.html_url,
            stars: r.stargazers_count,
            forks: r.forks_count,
            language: r.language ?? null,
            topics: r.topics ?? [],
            private: r.private,
            updated_at: r.updated_at,
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
          return { success: false, error: `Failed to search repositories: ${formatError(err)}` };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_list_branches
    // -------------------------------------------------------------------------
    {
      name: "github_list_branches",
      description:
        "Use this when the user wants to list the branches in a GitHub repository. " +
        "Returns branch names with their latest commit SHA and protection status.",
      category: "data-bearing",
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
          protected: {
            type: "boolean",
            description: "Filter to only protected branches (optional)",
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
        required: ["owner", "repo"],
      },
      execute: async (params, _context) => {
        try {
          const check = validateRequired(params, ["owner", "repo"]);
          if (!check.valid) return { success: false, error: check.error };

          const client = createGitHubClient(sdk);
          const perPage = clampInt(params.per_page, 1, 100, 30);
          const page = clampInt(params.page, 1, 9999, 1);

          const queryParams = { per_page: perPage, page };
          if (params.protected !== undefined) queryParams.protected = params.protected;

          const { data, pagination } = await client.getPaginated(
            `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/branches`,
            queryParams
          );

          const branches = Array.isArray(data) ? data : [];

          sdk.log.info(
            `github_list_branches: fetched ${branches.length} branches in ${params.owner}/${params.repo}`
          );

          const branchList = branches.map((b) => ({
            name: b.name,
            sha: b.commit?.sha ?? null,
            protected: b.protected ?? false,
          }));

          return {
            success: true,
            data: {
              repo: `${params.owner}/${params.repo}`,
              branches: branchList,
              count: branchList.length,
              next_page: pagination.next ?? null,
            },
          };
        } catch (err) {
          return { success: false, error: `Failed to list branches: ${formatError(err)}` };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_push_files
    // -------------------------------------------------------------------------
    {
      name: "github_push_files",
      description:
        "Use this when the user wants to commit multiple files to a GitHub repository in a single operation. " +
        "Creates or updates multiple files with one commit. Each file should have a path and content.",
      category: "action",
      scope: "dm-only",
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
            description: "Branch to push to",
          },
          message: {
            type: "string",
            description: "Commit message",
          },
          files: {
            type: "array",
            description: "Array of files to create or update",
            items: {
              type: "object",
              properties: {
                path: { type: "string", description: "File path in the repository" },
                content: { type: "string", description: "File content (text)" },
              },
              required: ["path", "content"],
            },
          },
        },
        required: ["owner", "repo", "branch", "message", "files"],
      },
      execute: async (params, _context) => {
        try {
          const check = validateRequired(params, ["owner", "repo", "branch", "message", "files"]);
          if (!check.valid) return { success: false, error: check.error };

          if (!Array.isArray(params.files) || params.files.length === 0) {
            return { success: false, error: "files must be a non-empty array" };
          }

          const client = createGitHubClient(sdk);
          const owner = encodeURIComponent(params.owner);
          const repoName = encodeURIComponent(params.repo);

          // Step 1: Get the current branch's HEAD commit SHA and tree SHA
          const branchData = await client.get(
            `/repos/${owner}/${repoName}/git/ref/heads/${encodeURIComponent(params.branch)}`
          );
          const headSha = branchData?.object?.sha;
          if (!headSha) {
            return { success: false, error: `Branch '${params.branch}' not found or has no commits.` };
          }

          const headCommit = await client.get(`/repos/${owner}/${repoName}/git/commits/${headSha}`);
          const baseTreeSha = headCommit?.tree?.sha;
          if (!baseTreeSha) {
            return { success: false, error: "Could not retrieve base tree SHA." };
          }

          // Step 2: Create blobs for each file
          const treeEntries = [];
          for (const file of params.files) {
            if (!file.path || file.content === undefined) {
              return { success: false, error: `Each file must have 'path' and 'content'. Invalid entry: ${JSON.stringify(file)}` };
            }
            const blob = await client.post(`/repos/${owner}/${repoName}/git/blobs`, {
              content: file.content,
              encoding: "utf-8",
            });
            treeEntries.push({
              path: file.path,
              mode: "100644",
              type: "blob",
              sha: blob.sha,
            });
          }

          // Step 3: Create a new tree
          const newTree = await client.post(`/repos/${owner}/${repoName}/git/trees`, {
            base_tree: baseTreeSha,
            tree: treeEntries,
          });

          // Step 4: Create the commit
          const authorName = sdk.pluginConfig?.commit_author_name ?? "Teleton AI Agent";
          const authorEmail = sdk.pluginConfig?.commit_author_email ?? "agent@teleton.local";

          const newCommit = await client.post(`/repos/${owner}/${repoName}/git/commits`, {
            message: params.message,
            tree: newTree.sha,
            parents: [headSha],
            author: { name: authorName, email: authorEmail },
          });

          // Step 5: Update the branch reference
          await client.patch(
            `/repos/${owner}/${repoName}/git/refs/heads/${encodeURIComponent(params.branch)}`,
            { sha: newCommit.sha, force: false }
          );

          sdk.log.info(
            `github_push_files: committed ${params.files.length} file(s) to ${params.owner}/${params.repo}@${params.branch}`
          );

          return {
            success: true,
            data: {
              repo: `${params.owner}/${params.repo}`,
              branch: params.branch,
              commit_sha: newCommit.sha,
              commit_url: newCommit.html_url ?? null,
              files_changed: params.files.map((f) => f.path),
              message: `Successfully committed ${params.files.length} file(s).`,
            },
          };
        } catch (err) {
          return { success: false, error: `Failed to push files: ${formatError(err)}` };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_get_repo_tree
    // -------------------------------------------------------------------------
    {
      name: "github_get_repo_tree",
      description:
        "Use this when the user wants to see the full file tree of a GitHub repository. " +
        "Returns the complete list of files and directories. Optionally recursive.",
      category: "data-bearing",
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
          tree_sha: {
            type: "string",
            description: "Branch name, tag, or commit SHA to get the tree for (default: HEAD of default branch)",
          },
          recursive: {
            type: "boolean",
            description: "Whether to recursively include all nested files (default: true)",
          },
        },
        required: ["owner", "repo"],
      },
      execute: async (params, _context) => {
        try {
          const check = validateRequired(params, ["owner", "repo"]);
          if (!check.valid) return { success: false, error: check.error };

          const client = createGitHubClient(sdk);
          const treeSha = params.tree_sha ?? "HEAD";
          const recursive = params.recursive !== false ? "1" : "0";

          const data = await client.get(
            `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/git/trees/${encodeURIComponent(treeSha)}`,
            { recursive }
          );

          const tree = Array.isArray(data?.tree) ? data.tree : [];

          sdk.log.info(
            `github_get_repo_tree: retrieved ${tree.length} entries from ${params.owner}/${params.repo}@${treeSha}`
          );

          const entries = tree.map((e) => ({
            path: e.path,
            type: e.type, // "blob" or "tree"
            size: e.size ?? null,
            sha: e.sha,
          }));

          return {
            success: true,
            data: {
              repo: `${params.owner}/${params.repo}`,
              sha: data?.sha ?? treeSha,
              truncated: data?.truncated ?? false,
              entries,
              count: entries.length,
            },
          };
        } catch (err) {
          return { success: false, error: `Failed to get repository tree: ${formatError(err)}` };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_list_tags
    // -------------------------------------------------------------------------
    {
      name: "github_list_tags",
      description:
        "Use this when the user wants to list the tags in a GitHub repository. " +
        "Returns tag names with their associated commit SHA.",
      category: "data-bearing",
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
        required: ["owner", "repo"],
      },
      execute: async (params, _context) => {
        try {
          const check = validateRequired(params, ["owner", "repo"]);
          if (!check.valid) return { success: false, error: check.error };

          const client = createGitHubClient(sdk);
          const perPage = clampInt(params.per_page, 1, 100, 30);
          const page = clampInt(params.page, 1, 9999, 1);

          const { data, pagination } = await client.getPaginated(
            `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/tags`,
            { per_page: perPage, page }
          );

          const tags = Array.isArray(data) ? data : [];

          sdk.log.info(
            `github_list_tags: fetched ${tags.length} tags in ${params.owner}/${params.repo}`
          );

          const tagList = tags.map((t) => ({
            name: t.name,
            sha: t.commit?.sha ?? null,
            zipball_url: t.zipball_url ?? null,
            tarball_url: t.tarball_url ?? null,
          }));

          return {
            success: true,
            data: {
              repo: `${params.owner}/${params.repo}`,
              tags: tagList,
              count: tagList.length,
              next_page: pagination.next ?? null,
            },
          };
        } catch (err) {
          return { success: false, error: `Failed to list tags: ${formatError(err)}` };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_list_releases
    // -------------------------------------------------------------------------
    {
      name: "github_list_releases",
      description:
        "Use this when the user wants to see releases for a GitHub repository. " +
        "Returns a list of releases with their tag, name, and publish date.",
      category: "data-bearing",
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
        required: ["owner", "repo"],
      },
      execute: async (params, _context) => {
        try {
          const check = validateRequired(params, ["owner", "repo"]);
          if (!check.valid) return { success: false, error: check.error };

          const client = createGitHubClient(sdk);
          const perPage = clampInt(params.per_page, 1, 100, 30);
          const page = clampInt(params.page, 1, 9999, 1);

          const { data, pagination } = await client.getPaginated(
            `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/releases`,
            { per_page: perPage, page }
          );

          const releases = Array.isArray(data) ? data : [];

          sdk.log.info(
            `github_list_releases: fetched ${releases.length} releases in ${params.owner}/${params.repo}`
          );

          const releaseList = releases.map((r) => ({
            id: r.id,
            tag_name: r.tag_name,
            name: r.name ?? r.tag_name,
            draft: r.draft,
            prerelease: r.prerelease,
            published_at: r.published_at,
            html_url: r.html_url,
            body: r.body ? r.body.slice(0, 500) : null,
          }));

          return {
            success: true,
            data: {
              repo: `${params.owner}/${params.repo}`,
              releases: releaseList,
              count: releaseList.length,
              next_page: pagination.next ?? null,
            },
          };
        } catch (err) {
          return { success: false, error: `Failed to list releases: ${formatError(err)}` };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_get_latest_release
    // -------------------------------------------------------------------------
    {
      name: "github_get_latest_release",
      description:
        "Use this when the user wants to get the latest stable release of a GitHub repository. " +
        "Returns the release details including tag name, assets, and changelog.",
      category: "data-bearing",
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

          const r = await client.get(
            `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/releases/latest`
          );

          sdk.log.info(
            `github_get_latest_release: latest release is ${r?.tag_name} in ${params.owner}/${params.repo}`
          );

          return {
            success: true,
            data: {
              repo: `${params.owner}/${params.repo}`,
              id: r?.id ?? null,
              tag_name: r?.tag_name ?? null,
              name: r?.name ?? r?.tag_name ?? null,
              draft: r?.draft ?? false,
              prerelease: r?.prerelease ?? false,
              published_at: r?.published_at ?? null,
              html_url: r?.html_url ?? null,
              body: r?.body ? r.body.slice(0, 1000) : null,
              assets: (r?.assets ?? []).map((a) => ({
                name: a.name,
                size: a.size,
                download_url: a.browser_download_url,
              })),
            },
          };
        } catch (err) {
          return { success: false, error: `Failed to get latest release: ${formatError(err)}` };
        }
      },
    },
  ];
}
