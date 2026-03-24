/**
 * Security and discussion operations for the github-dev-assistant plugin.
 *
 * Covers:
 *  - github_list_code_scanning_alerts  — list code scanning (SAST) alerts
 *  - github_list_dependabot_alerts     — list Dependabot vulnerability alerts
 *  - github_list_discussions           — list repository discussions
 *  - github_get_discussion             — get a specific discussion
 *
 * All tools create a fresh GitHub client per execution to pick up the latest
 * token from sdk.secrets (avoids stale client issues).
 *
 * All tools return { success, data?, error? } per the SDK ToolResult contract.
 */

import { createGitHubClient } from "./github-client.js";
import { validateRequired, clampInt, formatError } from "./utils.js";

/**
 * Build security and discussion tools.
 *
 * @param {object} sdk - Teleton plugin SDK (for config, logging, secrets)
 * @returns {object[]} Array of tool definitions
 */
export function buildSecurityDiscussionOpsTools(sdk) {
  return [
    // -------------------------------------------------------------------------
    // Tool: github_list_code_scanning_alerts
    // -------------------------------------------------------------------------
    {
      name: "github_list_code_scanning_alerts",
      description:
        "Use this when the user wants to see code scanning (SAST) alerts for a GitHub repository. " +
        "Returns security vulnerabilities found by GitHub Advanced Security or third-party tools. " +
        "Requires the repository to have code scanning enabled.",
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
          state: {
            type: "string",
            enum: ["open", "dismissed", "fixed", "auto_dismissed"],
            description: "Filter by alert state (default: open)",
          },
          severity: {
            type: "string",
            enum: ["critical", "high", "medium", "low", "warning", "note", "error"],
            description: "Filter by severity level (optional)",
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
          if (params.state) queryParams.state = params.state;
          if (params.severity) queryParams.severity = params.severity;

          const { data, pagination } = await client.getPaginated(
            `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/code-scanning/alerts`,
            queryParams
          );

          const alerts = Array.isArray(data) ? data : [];

          sdk.log.info(
            `github_list_code_scanning_alerts: fetched ${alerts.length} alerts in ${params.owner}/${params.repo}`
          );

          const alertList = alerts.map((a) => ({
            number: a.number,
            state: a.state,
            rule_id: a.rule?.id ?? null,
            rule_name: a.rule?.name ?? null,
            severity: a.rule?.security_severity_level ?? a.rule?.severity ?? null,
            description: a.rule?.description ?? null,
            tool: a.tool?.name ?? null,
            file: a.most_recent_instance?.location?.path ?? null,
            line: a.most_recent_instance?.location?.start_line ?? null,
            html_url: a.html_url,
            created_at: a.created_at,
            dismissed_at: a.dismissed_at ?? null,
          }));

          return {
            success: true,
            data: {
              repo: `${params.owner}/${params.repo}`,
              alerts: alertList,
              count: alertList.length,
              next_page: pagination.next ?? null,
            },
          };
        } catch (err) {
          if (err.status === 404) {
            return {
              success: false,
              error: `Code scanning is not enabled for ${params.owner}/${params.repo}, or the repository was not found.`,
            };
          }
          return { success: false, error: `Failed to list code scanning alerts: ${formatError(err)}` };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_list_dependabot_alerts
    // -------------------------------------------------------------------------
    {
      name: "github_list_dependabot_alerts",
      description:
        "Use this when the user wants to see Dependabot vulnerability alerts for a GitHub repository. " +
        "Returns dependency vulnerabilities with CVE IDs, severity, and affected package info. " +
        "Requires Dependabot to be enabled on the repository.",
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
          state: {
            type: "string",
            enum: ["open", "dismissed", "fixed", "auto_dismissed"],
            description: "Filter by alert state (default: open)",
          },
          severity: {
            type: "string",
            enum: ["critical", "high", "medium", "low"],
            description: "Filter by severity level (optional)",
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
          if (params.state) queryParams.state = params.state;
          if (params.severity) queryParams.severity = params.severity;

          const { data, pagination } = await client.getPaginated(
            `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/dependabot/alerts`,
            queryParams
          );

          const alerts = Array.isArray(data) ? data : [];

          sdk.log.info(
            `github_list_dependabot_alerts: fetched ${alerts.length} alerts in ${params.owner}/${params.repo}`
          );

          const alertList = alerts.map((a) => ({
            number: a.number,
            state: a.state,
            severity: a.security_advisory?.severity ?? null,
            cve_id: a.security_advisory?.cve_id ?? null,
            summary: a.security_advisory?.summary ?? null,
            package_name: a.dependency?.package?.name ?? null,
            package_ecosystem: a.dependency?.package?.ecosystem ?? null,
            vulnerable_version_range: a.security_vulnerability?.vulnerable_version_range ?? null,
            patched_versions: a.security_vulnerability?.first_patched_version?.identifier ?? null,
            html_url: a.html_url,
            created_at: a.created_at,
            dismissed_at: a.dismissed_at ?? null,
          }));

          return {
            success: true,
            data: {
              repo: `${params.owner}/${params.repo}`,
              alerts: alertList,
              count: alertList.length,
              next_page: pagination.next ?? null,
            },
          };
        } catch (err) {
          if (err.status === 404) {
            return {
              success: false,
              error: `Dependabot alerts are not enabled for ${params.owner}/${params.repo}, or the repository was not found.`,
            };
          }
          return { success: false, error: `Failed to list Dependabot alerts: ${formatError(err)}` };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_list_discussions
    // -------------------------------------------------------------------------
    {
      name: "github_list_discussions",
      description:
        "Use this when the user wants to list discussions in a GitHub repository. " +
        "Uses the GitHub GraphQL API to fetch discussions with their categories and comment counts. " +
        "Requires Discussions to be enabled on the repository.",
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
          first: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description: "Number of discussions to fetch (1-100, default: 20)",
          },
          category: {
            type: "string",
            description: "Filter by category name (optional)",
          },
        },
        required: ["owner", "repo"],
      },
      execute: async (params, _context) => {
        try {
          const check = validateRequired(params, ["owner", "repo"]);
          if (!check.valid) return { success: false, error: check.error };

          const client = createGitHubClient(sdk);
          const first = clampInt(params.first, 1, 100, 20);

          // Use GraphQL API for discussions
          const query = `
            query($owner: String!, $repo: String!, $first: Int!) {
              repository(owner: $owner, name: $repo) {
                discussions(first: $first, orderBy: {field: UPDATED_AT, direction: DESC}) {
                  nodes {
                    number
                    title
                    url
                    author { login }
                    category { name }
                    comments { totalCount }
                    createdAt
                    updatedAt
                    answered
                    locked
                  }
                  pageInfo {
                    hasNextPage
                    endCursor
                  }
                }
              }
            }
          `;

          const result = await client.graphql(query, {
            owner: params.owner,
            repo: params.repo,
            first,
          });

          const discussions = result?.data?.repository?.discussions?.nodes ?? [];
          const pageInfo = result?.data?.repository?.discussions?.pageInfo ?? {};

          sdk.log.info(
            `github_list_discussions: fetched ${discussions.length} discussions in ${params.owner}/${params.repo}`
          );

          let discussionList = discussions.map((d) => ({
            number: d.number,
            title: d.title,
            url: d.url,
            author: d.author?.login ?? null,
            category: d.category?.name ?? null,
            comment_count: d.comments?.totalCount ?? 0,
            answered: d.answered ?? false,
            locked: d.locked ?? false,
            created_at: d.createdAt,
            updated_at: d.updatedAt,
          }));

          // Filter by category if requested
          if (params.category) {
            discussionList = discussionList.filter(
              (d) => d.category?.toLowerCase() === params.category.toLowerCase()
            );
          }

          return {
            success: true,
            data: {
              repo: `${params.owner}/${params.repo}`,
              discussions: discussionList,
              count: discussionList.length,
              has_next_page: pageInfo.hasNextPage ?? false,
            },
          };
        } catch (err) {
          return { success: false, error: `Failed to list discussions: ${formatError(err)}` };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_get_discussion
    // -------------------------------------------------------------------------
    {
      name: "github_get_discussion",
      description:
        "Use this when the user wants to read a specific GitHub discussion, including its body and comments. " +
        "Uses the GitHub GraphQL API.",
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
          discussion_number: {
            type: "integer",
            description: "Discussion number",
          },
        },
        required: ["owner", "repo", "discussion_number"],
      },
      execute: async (params, _context) => {
        try {
          const check = validateRequired(params, ["owner", "repo", "discussion_number"]);
          if (!check.valid) return { success: false, error: check.error };

          const discussionNumber = Math.floor(Number(params.discussion_number));
          if (!Number.isFinite(discussionNumber) || discussionNumber < 1) {
            return { success: false, error: "discussion_number must be a positive integer" };
          }

          const client = createGitHubClient(sdk);

          const query = `
            query($owner: String!, $repo: String!, $number: Int!) {
              repository(owner: $owner, name: $repo) {
                discussion(number: $number) {
                  number
                  title
                  body
                  url
                  author { login }
                  category { name }
                  answered
                  locked
                  createdAt
                  updatedAt
                  comments(first: 20) {
                    nodes {
                      author { login }
                      body
                      createdAt
                      isAnswer
                    }
                    totalCount
                  }
                }
              }
            }
          `;

          const result = await client.graphql(query, {
            owner: params.owner,
            repo: params.repo,
            number: discussionNumber,
          });

          const d = result?.data?.repository?.discussion;
          if (!d) {
            return {
              success: false,
              error: `Discussion #${discussionNumber} not found in ${params.owner}/${params.repo}`,
            };
          }

          sdk.log.info(
            `github_get_discussion: fetched discussion #${discussionNumber} in ${params.owner}/${params.repo}`
          );

          return {
            success: true,
            data: {
              number: d.number,
              title: d.title,
              body: d.body ?? null,
              url: d.url,
              author: d.author?.login ?? null,
              category: d.category?.name ?? null,
              answered: d.answered ?? false,
              locked: d.locked ?? false,
              created_at: d.createdAt,
              updated_at: d.updatedAt,
              comment_count: d.comments?.totalCount ?? 0,
              comments: (d.comments?.nodes ?? []).map((c) => ({
                author: c.author?.login ?? null,
                body: c.body ?? null,
                created_at: c.createdAt,
                is_answer: c.isAnswer ?? false,
              })),
            },
          };
        } catch (err) {
          return { success: false, error: `Failed to get discussion: ${formatError(err)}` };
        }
      },
    },
  ];
}
