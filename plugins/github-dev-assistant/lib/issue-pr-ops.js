/**
 * Extended issue and pull request operations for the github-dev-assistant plugin.
 *
 * Covers:
 *  - github_list_comments           — list comments on an issue or PR
 *  - github_update_issue            — update an existing issue
 *  - github_reopen_issue            — reopen a closed issue
 *  - github_assign_issue            — assign an issue to users
 *  - github_list_pull_request_reviews — list reviews on a PR
 *
 * All tools create a fresh GitHub client per execution to pick up the latest
 * token from sdk.secrets (avoids stale client issues).
 *
 * All tools return { success, data?, error? } per the SDK ToolResult contract.
 */

import { createGitHubClient } from "./github-client.js";
import { validateRequired, validateEnum, clampInt, formatError } from "./utils.js";

/**
 * Build extended issue and PR operation tools.
 *
 * @param {object} sdk - Teleton plugin SDK
 * @returns {object[]} Array of tool definitions
 */
export function buildIssuePROpsTools(sdk) {
  return [
    // -------------------------------------------------------------------------
    // Tool: github_list_comments
    // -------------------------------------------------------------------------
    {
      name: "github_list_comments",
      description:
        "Use this when the user wants to see comments on a GitHub issue or pull request. " +
        "Provide either issue_number or pr_number (they are equivalent — issues and PRs share numbers). " +
        "Returns a list of comments with author, body, and URL.",
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
          issue_number: {
            type: "integer",
            description: "Issue or PR number to list comments for (required)",
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
        required: ["owner", "repo", "issue_number"],
      },
      execute: async (params, _context) => {
        try {
          const check = validateRequired(params, ["owner", "repo", "issue_number"]);
          if (!check.valid) return { success: false, error: check.error };

          const issueNum = Math.floor(Number(params.issue_number));
          if (!Number.isFinite(issueNum) || issueNum < 1) {
            return { success: false, error: "issue_number must be a positive integer" };
          }

          const client = createGitHubClient(sdk);
          const perPage = clampInt(params.per_page, 1, 100, 30);
          const page = clampInt(params.page, 1, 9999, 1);

          const { data, pagination } = await client.getPaginated(
            `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/issues/${issueNum}/comments`,
            { per_page: perPage, page }
          );

          const comments = Array.isArray(data) ? data : [];

          sdk.log.info(
            `github_list_comments: fetched ${comments.length} comments on #${issueNum} in ${params.owner}/${params.repo}`
          );

          const commentList = comments.map((c) => ({
            id: c.id,
            author: c.user?.login ?? null,
            body: c.body,
            created_at: c.created_at,
            updated_at: c.updated_at,
            html_url: c.html_url,
          }));

          return {
            success: true,
            data: {
              issue_number: issueNum,
              repo: `${params.owner}/${params.repo}`,
              comments: commentList,
              count: commentList.length,
              next_page: pagination.next ?? null,
            },
          };
        } catch (err) {
          return { success: false, error: `Failed to list comments: ${formatError(err)}` };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_update_issue
    // -------------------------------------------------------------------------
    {
      name: "github_update_issue",
      description:
        "Use this when the user wants to update the title, body, labels, or state of an existing GitHub issue. " +
        "Returns a confirmation with the updated issue URL.",
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
          issue_number: {
            type: "integer",
            description: "Issue number to update (required)",
          },
          title: {
            type: "string",
            description: "New issue title",
          },
          body: {
            type: "string",
            description: "New issue body (Markdown supported)",
          },
          state: {
            type: "string",
            enum: ["open", "closed"],
            description: "New issue state",
          },
          labels: {
            type: "array",
            items: { type: "string" },
            description: "New set of labels (replaces existing labels)",
          },
          assignees: {
            type: "array",
            items: { type: "string" },
            description: "New set of assignees — GitHub usernames (replaces existing assignees)",
          },
          milestone: {
            type: "integer",
            description: "Milestone number to associate (use null to clear)",
          },
        },
        required: ["owner", "repo", "issue_number"],
      },
      execute: async (params, _context) => {
        try {
          const check = validateRequired(params, ["owner", "repo", "issue_number"]);
          if (!check.valid) return { success: false, error: check.error };

          const issueNum = Math.floor(Number(params.issue_number));
          if (!Number.isFinite(issueNum) || issueNum < 1) {
            return { success: false, error: "issue_number must be a positive integer" };
          }

          const stateVal = validateEnum(params.state, ["open", "closed"], null);
          if (!stateVal.valid) return { success: false, error: stateVal.error };

          const client = createGitHubClient(sdk);
          const body = {};

          if (params.title !== undefined) body.title = params.title;
          if (params.body !== undefined) body.body = params.body;
          if (stateVal.value !== null) body.state = stateVal.value;
          if (Array.isArray(params.labels)) body.labels = params.labels;
          if (Array.isArray(params.assignees)) body.assignees = params.assignees;
          if (params.milestone !== undefined) body.milestone = params.milestone;

          if (Object.keys(body).length === 0) {
            return {
              success: false,
              error: "No fields to update. Provide at least one of: title, body, state, labels, assignees, milestone.",
            };
          }

          const issue = await client.patch(
            `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/issues/${issueNum}`,
            body
          );

          sdk.log.info(
            `github_update_issue: updated #${issueNum} in ${params.owner}/${params.repo}`
          );

          return {
            success: true,
            data: {
              number: issueNum,
              title: issue.title,
              state: issue.state,
              html_url: issue.html_url,
              labels: issue.labels?.map((l) => (typeof l === "string" ? l : l.name)) ?? [],
              assignees: issue.assignees?.map((a) => a.login) ?? [],
            },
          };
        } catch (err) {
          return { success: false, error: `Failed to update issue: ${formatError(err)}` };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_reopen_issue
    // -------------------------------------------------------------------------
    {
      name: "github_reopen_issue",
      description:
        "Use this when the user wants to reopen a closed GitHub issue. " +
        "Returns a confirmation with the issue URL.",
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
          issue_number: {
            type: "integer",
            description: "Issue number to reopen (required)",
          },
          comment: {
            type: "string",
            description: "Optional comment to post when reopening",
          },
        },
        required: ["owner", "repo", "issue_number"],
      },
      execute: async (params, _context) => {
        try {
          const check = validateRequired(params, ["owner", "repo", "issue_number"]);
          if (!check.valid) return { success: false, error: check.error };

          const issueNum = Math.floor(Number(params.issue_number));
          if (!Number.isFinite(issueNum) || issueNum < 1) {
            return { success: false, error: "issue_number must be a positive integer" };
          }

          const client = createGitHubClient(sdk);
          const owner = encodeURIComponent(params.owner);
          const repo = encodeURIComponent(params.repo);

          // Post comment first if provided
          if (params.comment) {
            await client.post(`/repos/${owner}/${repo}/issues/${issueNum}/comments`, {
              body: params.comment,
            });
          }

          const issue = await client.patch(
            `/repos/${owner}/${repo}/issues/${issueNum}`,
            { state: "open" }
          );

          sdk.log.info(
            `github_reopen_issue: reopened #${issueNum} in ${params.owner}/${params.repo}`
          );

          return {
            success: true,
            data: {
              number: issueNum,
              title: issue.title,
              html_url: issue.html_url,
              state: "open",
            },
          };
        } catch (err) {
          return { success: false, error: `Failed to reopen issue: ${formatError(err)}` };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_assign_issue
    // -------------------------------------------------------------------------
    {
      name: "github_assign_issue",
      description:
        "Use this when the user wants to assign or unassign a GitHub issue to one or more users. " +
        "Replaces all current assignees with the provided list (pass empty array to clear). " +
        "Returns a confirmation.",
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
          issue_number: {
            type: "integer",
            description: "Issue number to assign (required)",
          },
          assignees: {
            type: "array",
            items: { type: "string" },
            description: "GitHub usernames to assign. Pass an empty array to remove all assignees.",
          },
        },
        required: ["owner", "repo", "issue_number", "assignees"],
      },
      execute: async (params, _context) => {
        try {
          const check = validateRequired(params, ["owner", "repo", "issue_number"]);
          if (!check.valid) return { success: false, error: check.error };

          const issueNum = Math.floor(Number(params.issue_number));
          if (!Number.isFinite(issueNum) || issueNum < 1) {
            return { success: false, error: "issue_number must be a positive integer" };
          }

          if (!Array.isArray(params.assignees)) {
            return { success: false, error: "assignees must be an array of GitHub usernames" };
          }

          const client = createGitHubClient(sdk);

          const issue = await client.patch(
            `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/issues/${issueNum}`,
            { assignees: params.assignees }
          );

          sdk.log.info(
            `github_assign_issue: assigned #${issueNum} in ${params.owner}/${params.repo} to [${params.assignees.join(", ")}]`
          );

          return {
            success: true,
            data: {
              number: issueNum,
              title: issue.title,
              html_url: issue.html_url,
              assignees: issue.assignees?.map((a) => a.login) ?? [],
            },
          };
        } catch (err) {
          return { success: false, error: `Failed to assign issue: ${formatError(err)}` };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_list_pull_request_reviews
    // -------------------------------------------------------------------------
    {
      name: "github_list_pull_request_reviews",
      description:
        "Use this when the user wants to see reviews on a GitHub pull request. " +
        "Returns a list of reviews with reviewer, state (APPROVED/CHANGES_REQUESTED/COMMENTED), and body.",
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
          pr_number: {
            type: "integer",
            description: "Pull request number (required)",
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
        required: ["owner", "repo", "pr_number"],
      },
      execute: async (params, _context) => {
        try {
          const check = validateRequired(params, ["owner", "repo", "pr_number"]);
          if (!check.valid) return { success: false, error: check.error };

          const prNum = Math.floor(Number(params.pr_number));
          if (!Number.isFinite(prNum) || prNum < 1) {
            return { success: false, error: "pr_number must be a positive integer" };
          }

          const client = createGitHubClient(sdk);
          const perPage = clampInt(params.per_page, 1, 100, 30);
          const page = clampInt(params.page, 1, 9999, 1);

          const { data, pagination } = await client.getPaginated(
            `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/pulls/${prNum}/reviews`,
            { per_page: perPage, page }
          );

          const reviews = Array.isArray(data) ? data : [];

          sdk.log.info(
            `github_list_pull_request_reviews: fetched ${reviews.length} reviews on PR #${prNum} in ${params.owner}/${params.repo}`
          );

          const reviewList = reviews.map((r) => ({
            id: r.id,
            reviewer: r.user?.login ?? null,
            state: r.state,
            body: r.body ?? null,
            submitted_at: r.submitted_at,
            html_url: r.html_url,
          }));

          return {
            success: true,
            data: {
              pr_number: prNum,
              repo: `${params.owner}/${params.repo}`,
              reviews: reviewList,
              count: reviewList.length,
              next_page: pagination.next ?? null,
            },
          };
        } catch (err) {
          return { success: false, error: `Failed to list pull request reviews: ${formatError(err)}` };
        }
      },
    },
  ];
}
