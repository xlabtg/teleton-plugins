/**
 * Commit operations for the github-dev-assistant plugin.
 *
 * Covers:
 *  - github_list_commits — list commits in a repository
 *  - github_get_commit   — get detailed information about a specific commit
 *
 * All tools create a fresh GitHub client per execution to pick up the latest
 * token from sdk.secrets (avoids stale client issues).
 *
 * All tools return { success, data?, error? } per the SDK ToolResult contract.
 */

import { createGitHubClient } from "./github-client.js";
import { validateRequired, clampInt, formatError } from "./utils.js";

/**
 * Build commit operation tools.
 *
 * @param {object} sdk - Teleton plugin SDK
 * @returns {object[]} Array of tool definitions
 */
export function buildCommitOpsTools(sdk) {
  return [
    // -------------------------------------------------------------------------
    // Tool: github_list_commits
    // -------------------------------------------------------------------------
    {
      name: "github_list_commits",
      description:
        "Use this when the user wants to see commit history in a GitHub repository. " +
        "Returns a list of commits with SHA, author, date, and message.",
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
          branch: {
            type: "string",
            description: "Branch name or SHA to list commits from (default: repo default branch)",
          },
          path: {
            type: "string",
            description: "Filter commits that touched this file/directory path",
          },
          author: {
            type: "string",
            description: "Filter commits by author GitHub username or email",
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
          if (params.branch) queryParams.sha = params.branch;
          if (params.path) queryParams.path = params.path;
          if (params.author) queryParams.author = params.author;

          const { data, pagination } = await client.getPaginated(
            `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/commits`,
            queryParams
          );

          const commits = Array.isArray(data) ? data : [];

          sdk.log.info(
            `github_list_commits: fetched ${commits.length} commits from ${params.owner}/${params.repo}`
          );

          const commitList = commits.map((c) => ({
            sha: c.sha,
            short_sha: c.sha?.slice(0, 7) ?? null,
            message: c.commit?.message?.split("\n")[0] ?? null,
            author: c.commit?.author?.name ?? c.author?.login ?? null,
            date: c.commit?.author?.date ?? null,
            html_url: c.html_url,
          }));

          return {
            success: true,
            data: {
              repo: `${params.owner}/${params.repo}`,
              branch: params.branch ?? null,
              commits: commitList,
              count: commitList.length,
              next_page: pagination.next ?? null,
            },
          };
        } catch (err) {
          return { success: false, error: `Failed to list commits: ${formatError(err)}` };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_get_commit
    // -------------------------------------------------------------------------
    {
      name: "github_get_commit",
      description:
        "Use this when the user wants detailed information about a specific commit in a GitHub repository. " +
        "Returns commit details including changed files, additions, deletions, and the full diff.",
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
          commit_sha: {
            type: "string",
            description: "Full or abbreviated commit SHA (required)",
          },
        },
        required: ["owner", "repo", "commit_sha"],
      },
      execute: async (params, _context) => {
        try {
          const check = validateRequired(params, ["owner", "repo", "commit_sha"]);
          if (!check.valid) return { success: false, error: check.error };

          const client = createGitHubClient(sdk);

          const commit = await client.get(
            `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/commits/${encodeURIComponent(params.commit_sha)}`
          );

          sdk.log.info(
            `github_get_commit: fetched commit ${params.commit_sha} from ${params.owner}/${params.repo}`
          );

          const files = Array.isArray(commit.files)
            ? commit.files.map((f) => ({
                filename: f.filename,
                status: f.status,
                additions: f.additions,
                deletions: f.deletions,
                changes: f.changes,
                patch: f.patch ?? null,
              }))
            : [];

          return {
            success: true,
            data: {
              sha: commit.sha,
              short_sha: commit.sha?.slice(0, 7) ?? null,
              message: commit.commit?.message ?? null,
              author: commit.commit?.author?.name ?? null,
              author_login: commit.author?.login ?? null,
              date: commit.commit?.author?.date ?? null,
              html_url: commit.html_url,
              stats: {
                total: commit.stats?.total ?? 0,
                additions: commit.stats?.additions ?? 0,
                deletions: commit.stats?.deletions ?? 0,
              },
              files,
              files_count: files.length,
            },
          };
        } catch (err) {
          return { success: false, error: `Failed to get commit: ${formatError(err)}` };
        }
      },
    },
  ];
}
