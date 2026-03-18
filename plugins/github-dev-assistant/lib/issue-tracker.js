/**
 * Issue management for the github-dev-assistant plugin.
 *
 * Covers:
 *  - github_create_issue  — create a new issue
 *  - github_list_issues   — list issues with filtering
 *  - github_comment_issue — add a comment to an issue or PR
 *  - github_close_issue   — close an issue or PR with optional comment
 *  - github_trigger_workflow — trigger a GitHub Actions workflow
 *
 * All tools create a fresh GitHub client per execution to pick up the latest
 * token from sdk.secrets (avoids stale client issues).
 *
 * All tools return { content: string } for direct LLM consumption.
 */

import { createGitHubClient } from "./github-client.js";
import { validateRequired, validateEnum, clampInt, formatError } from "./utils.js";

/**
 * Build issue tracking and workflow tools.
 *
 * @param {object} sdk - Teleton plugin SDK
 * @returns {object[]} Array of tool definitions
 */
export function buildIssueTrackerTools(sdk) {
  return [
    // -------------------------------------------------------------------------
    // Tool: github_create_issue
    // -------------------------------------------------------------------------
    {
      name: "github_create_issue",
      description:
        "Use this when the user wants to create a new issue or bug report in a GitHub repository. " +
        "Returns the issue number and URL.",
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
          title: {
            type: "string",
            description: "Issue title (required)",
          },
          body: {
            type: "string",
            description: "Issue description (Markdown supported)",
          },
          labels: {
            type: "array",
            items: { type: "string" },
            description: "Labels to apply (must exist in the repository)",
          },
          assignees: {
            type: "array",
            items: { type: "string" },
            description: "GitHub usernames to assign to this issue",
          },
          milestone: {
            type: "integer",
            description: "Milestone number to associate with the issue",
          },
        },
        required: ["owner", "repo", "title"],
      },
      execute: async (params) => {
        try {
          const check = validateRequired(params, ["owner", "repo", "title"]);
          if (!check.valid) return { content: `Error: ${check.error}` };

          const client = createGitHubClient(sdk);

          const body = { title: params.title };
          if (params.body) body.body = params.body;
          if (Array.isArray(params.labels) && params.labels.length > 0) {
            body.labels = params.labels;
          }
          if (Array.isArray(params.assignees) && params.assignees.length > 0) {
            body.assignees = params.assignees;
          }
          if (params.milestone) body.milestone = params.milestone;

          const issue = await client.post(
            `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/issues`,
            body
          );

          sdk.log.info(
            `github_create_issue: created issue #${issue.number} in ${params.owner}/${params.repo}`
          );

          const labels = issue.labels?.length
            ? ` [${issue.labels.map((l) => (typeof l === "string" ? l : l.name)).join(", ")}]`
            : "";
          return {
            content:
              `Issue #${issue.number} created: **${issue.title}**${labels}\n` +
              `URL: ${issue.html_url}`,
          };
        } catch (err) {
          return { content: `Failed to create issue: ${formatError(err)}` };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_list_issues
    // -------------------------------------------------------------------------
    {
      name: "github_list_issues",
      description:
        "Use this when the user wants to see open issues or a list of bugs/tasks in a GitHub repository. " +
        "Returns a formatted list of issues with title, author, labels, and URL.",
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
            enum: ["open", "closed", "all"],
            description: "Filter by issue state (default: open)",
          },
          labels: {
            type: "array",
            items: { type: "string" },
            description: "Filter by label names",
          },
          assignee: {
            type: "string",
            description: "Filter by assignee username. Use '*' for any assigned.",
          },
          creator: {
            type: "string",
            description: "Filter by issue creator username",
          },
          mentioned: {
            type: "string",
            description: "Filter issues that mention this username",
          },
          sort: {
            type: "string",
            enum: ["created", "updated", "comments"],
            description: "Sort field (default: created)",
          },
          direction: {
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
        required: ["owner", "repo"],
      },
      execute: async (params) => {
        try {
          const check = validateRequired(params, ["owner", "repo"]);
          if (!check.valid) return { content: `Error: ${check.error}` };

          const client = createGitHubClient(sdk);

          const stateVal = validateEnum(params.state, ["open", "closed", "all"], "open");
          const sortVal = validateEnum(params.sort, ["created", "updated", "comments"], "created");
          const directionVal = validateEnum(params.direction, ["asc", "desc"], "desc");

          if (!stateVal.valid) return { content: `Error: ${stateVal.error}` };
          if (!sortVal.valid) return { content: `Error: ${sortVal.error}` };
          if (!directionVal.valid) return { content: `Error: ${directionVal.error}` };

          const perPage = clampInt(params.per_page, 1, 100, 30);
          const page = clampInt(params.page, 1, 9999, 1);

          const queryParams = {
            state: stateVal.value,
            sort: sortVal.value,
            direction: directionVal.value,
            per_page: perPage,
            page,
          };
          if (Array.isArray(params.labels) && params.labels.length > 0) {
            queryParams.labels = params.labels.join(",");
          }
          if (params.assignee) queryParams.assignee = params.assignee;
          if (params.creator) queryParams.creator = params.creator;
          if (params.mentioned) queryParams.mentioned = params.mentioned;

          const { data, pagination } = await client.getPaginated(
            `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/issues`,
            queryParams
          );

          // Filter out PRs — GitHub issues API returns both
          const issues = Array.isArray(data) ? data.filter((i) => !i.pull_request) : [];

          sdk.log.info(
            `github_list_issues: fetched ${issues.length} issues from ${params.owner}/${params.repo}`
          );

          if (issues.length === 0) {
            return { content: `No ${stateVal.value} issues found in ${params.owner}/${params.repo}.` };
          }

          const lines = issues.map((issue) => {
            const labels = issue.labels?.length
              ? ` [${issue.labels.map((l) => (typeof l === "string" ? l : l.name)).join(", ")}]`
              : "";
            const assignee = issue.assignees?.length
              ? ` → @${issue.assignees.map((a) => a.login).join(", @")}`
              : "";
            return `- #${issue.number} **${issue.title}**${labels}${assignee} by @${issue.user?.login ?? "unknown"}\n  ${issue.html_url}`;
          });

          const pageInfo =
            pagination.next
              ? `\n\nPage ${page} of results. Use page=${pagination.next} to get more.`
              : "";

          return {
            content:
              `${stateVal.value.charAt(0).toUpperCase() + stateVal.value.slice(1)} issues in **${params.owner}/${params.repo}** (${issues.length} shown):\n\n` +
              lines.join("\n") +
              pageInfo,
          };
        } catch (err) {
          return { content: `Failed to list issues: ${formatError(err)}` };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_comment_issue
    // -------------------------------------------------------------------------
    {
      name: "github_comment_issue",
      description:
        "Use this when the user wants to add a comment to a GitHub issue or pull request. " +
        "Returns a confirmation with the comment URL.",
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
            description: "Issue or PR number to comment on (required)",
          },
          body: {
            type: "string",
            description: "Comment text (Markdown supported, required)",
          },
        },
        required: ["owner", "repo", "issue_number", "body"],
      },
      execute: async (params) => {
        try {
          const check = validateRequired(params, ["owner", "repo", "issue_number", "body"]);
          if (!check.valid) return { content: `Error: ${check.error}` };

          const issueNum = Math.floor(Number(params.issue_number));
          if (!Number.isFinite(issueNum) || issueNum < 1) {
            return { content: "Error: issue_number must be a positive integer" };
          }

          const client = createGitHubClient(sdk);

          const comment = await client.post(
            `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/issues/${issueNum}/comments`,
            { body: params.body }
          );

          sdk.log.info(
            `github_comment_issue: commented on #${issueNum} in ${params.owner}/${params.repo}`
          );

          return {
            content:
              `Comment added to #${issueNum} in ${params.owner}/${params.repo}.\n` +
              `URL: ${comment.html_url}`,
          };
        } catch (err) {
          return { content: `Failed to comment on issue: ${formatError(err)}` };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_close_issue
    // -------------------------------------------------------------------------
    {
      name: "github_close_issue",
      description:
        "Use this when the user wants to close a GitHub issue (mark as done or won't fix). " +
        "Optionally posts a closing comment. Returns a confirmation.",
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
            description: "Issue or PR number to close (required)",
          },
          comment: {
            type: "string",
            description: "Optional comment to post before closing",
          },
          reason: {
            type: "string",
            enum: ["completed", "not_planned"],
            description: "Close reason: 'completed' (done) or 'not_planned' (won't fix). Default: completed",
          },
        },
        required: ["owner", "repo", "issue_number"],
      },
      execute: async (params) => {
        try {
          const check = validateRequired(params, ["owner", "repo", "issue_number"]);
          if (!check.valid) return { content: `Error: ${check.error}` };

          const issueNum = Math.floor(Number(params.issue_number));
          if (!Number.isFinite(issueNum) || issueNum < 1) {
            return { content: "Error: issue_number must be a positive integer" };
          }

          const reasonVal = validateEnum(
            params.reason,
            ["completed", "not_planned"],
            "completed"
          );
          if (!reasonVal.valid) return { content: `Error: ${reasonVal.error}` };

          const client = createGitHubClient(sdk);
          const owner = encodeURIComponent(params.owner);
          const repo = encodeURIComponent(params.repo);

          // Post closing comment first if provided
          if (params.comment) {
            await client.post(`/repos/${owner}/${repo}/issues/${issueNum}/comments`, {
              body: params.comment,
            });
          }

          // Close the issue
          const issue = await client.patch(
            `/repos/${owner}/${repo}/issues/${issueNum}`,
            {
              state: "closed",
              state_reason: reasonVal.value,
            }
          );

          sdk.log.info(
            `github_close_issue: closed #${issueNum} in ${params.owner}/${params.repo} (${reasonVal.value})`
          );

          const reasonLabel = reasonVal.value === "not_planned" ? "won't fix" : "completed";
          return {
            content:
              `Issue #${issueNum} closed as ${reasonLabel}: **${issue.title}**\n` +
              `URL: ${issue.html_url}`,
          };
        } catch (err) {
          return { content: `Failed to close issue: ${formatError(err)}` };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_trigger_workflow
    // -------------------------------------------------------------------------
    {
      name: "github_trigger_workflow",
      description:
        "Use this when the user wants to manually trigger a GitHub Actions workflow (CI/CD pipeline). " +
        "The workflow must have workflow_dispatch configured. Returns a confirmation.",
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
          workflow_id: {
            type: "string",
            description:
              "Workflow file name (e.g. 'ci.yml') or numeric workflow ID (required)",
          },
          ref: {
            type: "string",
            description: "Branch or tag to run the workflow on (required, e.g. 'main')",
          },
          inputs: {
            type: "object",
            description: "Workflow input parameters (key-value pairs, optional)",
            additionalProperties: { type: "string" },
          },
        },
        required: ["owner", "repo", "workflow_id", "ref"],
      },
      execute: async (params) => {
        try {
          const check = validateRequired(params, ["owner", "repo", "workflow_id", "ref"]);
          if (!check.valid) return { content: `Error: ${check.error}` };

          const client = createGitHubClient(sdk);
          const owner = encodeURIComponent(params.owner);
          const repo = encodeURIComponent(params.repo);
          const workflowId = encodeURIComponent(params.workflow_id);

          const body = { ref: params.ref };
          if (params.inputs && typeof params.inputs === "object") {
            body.inputs = params.inputs;
          }

          // POST to /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches
          // Returns 204 No Content on success
          const { status } = await client.postRaw(
            `/repos/${owner}/${repo}/actions/workflows/${workflowId}/dispatches`,
            body
          );

          if (status !== 204) {
            return {
              content: `Failed to trigger workflow: unexpected response (HTTP ${status}).`,
            };
          }

          sdk.log.info(
            `github_trigger_workflow: triggered ${params.workflow_id} on ${params.ref} in ${params.owner}/${params.repo}`
          );

          return {
            content:
              `Workflow **${params.workflow_id}** triggered on \`${params.ref}\` in ${params.owner}/${params.repo}.\n` +
              (params.inputs && Object.keys(params.inputs).length
                ? `Inputs: ${JSON.stringify(params.inputs)}`
                : ""),
          };
        } catch (err) {
          return { content: `Failed to trigger workflow: ${formatError(err)}` };
        }
      },
    },
  ];
}
