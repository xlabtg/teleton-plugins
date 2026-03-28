/**
 * Repository information operations for the github-dev-assistant plugin.
 *
 * Covers:
 *  - github_list_languages     — list programming languages used in a repository
 *  - github_list_collaborators — list collaborators on a repository
 *  - github_list_teams         — list teams in an organization
 *
 * All tools create a fresh GitHub client per execution to pick up the latest
 * token from sdk.secrets (avoids stale client issues).
 *
 * All tools return { success, data?, error? } per the SDK ToolResult contract.
 */

import { createGitHubClient } from "./github-client.js";
import { validateRequired, clampInt, formatError } from "./utils.js";

/**
 * Build repository information tools.
 *
 * @param {object} sdk - Teleton plugin SDK
 * @returns {object[]} Array of tool definitions
 */
export function buildRepoInfoOpsTools(sdk) {
  return [
    // -------------------------------------------------------------------------
    // Tool: github_list_languages
    // -------------------------------------------------------------------------
    {
      name: "github_list_languages",
      description:
        "Use this when the user wants to know what programming languages are used in a GitHub repository. " +
        "Returns a breakdown of languages with byte counts and percentages.",
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

          const data = await client.get(
            `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/languages`
          );

          sdk.log.info(
            `github_list_languages: fetched languages for ${params.owner}/${params.repo}`
          );

          const totalBytes = Object.values(data).reduce((sum, v) => sum + v, 0);
          const languages = Object.entries(data)
            .sort((a, b) => b[1] - a[1])
            .map(([language, bytes]) => ({
              language,
              bytes,
              percentage: totalBytes > 0 ? Math.round((bytes / totalBytes) * 1000) / 10 : 0,
            }));

          return {
            success: true,
            data: {
              repo: `${params.owner}/${params.repo}`,
              languages,
              total_bytes: totalBytes,
            },
          };
        } catch (err) {
          return { success: false, error: `Failed to list languages: ${formatError(err)}` };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_list_collaborators
    // -------------------------------------------------------------------------
    {
      name: "github_list_collaborators",
      description:
        "Use this when the user wants to see who has access to a GitHub repository. " +
        "Returns a list of collaborators with their permission levels.",
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
          permission: {
            type: "string",
            enum: ["pull", "triage", "push", "maintain", "admin"],
            description: "Filter by permission level (optional)",
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
          if (params.permission) queryParams.permission = params.permission;

          const { data, pagination } = await client.getPaginated(
            `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/collaborators`,
            queryParams
          );

          const collaborators = Array.isArray(data) ? data : [];

          sdk.log.info(
            `github_list_collaborators: fetched ${collaborators.length} collaborators for ${params.owner}/${params.repo}`
          );

          const collaboratorList = collaborators.map((c) => ({
            login: c.login,
            html_url: c.html_url,
            permissions: c.permissions ?? null,
            role_name: c.role_name ?? null,
          }));

          return {
            success: true,
            data: {
              repo: `${params.owner}/${params.repo}`,
              collaborators: collaboratorList,
              count: collaboratorList.length,
              next_page: pagination.next ?? null,
            },
          };
        } catch (err) {
          return { success: false, error: `Failed to list collaborators: ${formatError(err)}` };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_list_teams
    // -------------------------------------------------------------------------
    {
      name: "github_list_teams",
      description:
        "Use this when the user wants to see teams in a GitHub organization. " +
        "Returns a list of teams with their slugs, descriptions, and privacy settings.",
      category: "data-bearing",
      parameters: {
        type: "object",
        properties: {
          owner: {
            type: "string",
            description: "Organization name (required — teams belong to organizations, not users)",
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
        required: ["owner"],
      },
      execute: async (params, _context) => {
        try {
          const check = validateRequired(params, ["owner"]);
          if (!check.valid) return { success: false, error: check.error };

          const client = createGitHubClient(sdk);
          const perPage = clampInt(params.per_page, 1, 100, 30);
          const page = clampInt(params.page, 1, 9999, 1);

          const { data, pagination } = await client.getPaginated(
            `/orgs/${encodeURIComponent(params.owner)}/teams`,
            { per_page: perPage, page }
          );

          const teams = Array.isArray(data) ? data : [];

          sdk.log.info(
            `github_list_teams: fetched ${teams.length} teams for org ${params.owner}`
          );

          const teamList = teams.map((t) => ({
            id: t.id,
            name: t.name,
            slug: t.slug,
            description: t.description ?? null,
            privacy: t.privacy,
            members_count: t.members_count ?? null,
            repos_count: t.repos_count ?? null,
            html_url: t.html_url,
          }));

          return {
            success: true,
            data: {
              org: params.owner,
              teams: teamList,
              count: teamList.length,
              next_page: pagination.next ?? null,
            },
          };
        } catch (err) {
          return { success: false, error: `Failed to list teams: ${formatError(err)}` };
        }
      },
    },
  ];
}
