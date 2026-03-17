/**
 * Issue management for the github-dev-assistant plugin.
 *
 * Covers:
 *  - github_create_issue  — create a new issue
 *  - github_list_issues   — list issues with filtering
 *  - github_comment_issue — add a comment to an issue or PR
 *  - github_close_issue   — close an issue or PR with optional comment
 *  - github_trigger_workflow — trigger a GitHub Actions workflow
 */

import { validateRequired, validateEnum, clampInt, formatError } from "./utils.js";

/**
 * Format an issue object to a clean, consistent shape.
 * @param {object} issue - Raw GitHub issue object
 * @returns {object}
 */
function formatIssue(issue) {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body ?? null,
    state: issue.state,
    state_reason: issue.state_reason ?? null,
    url: issue.html_url,
    author: issue.user?.login ?? null,
    assignees: (issue.assignees ?? []).map((a) => a.login),
    labels: (issue.labels ?? []).map((l) =>
      typeof l === "string" ? l : l.name
    ),
    milestone: issue.milestone?.title ?? null,
    comments: issue.comments ?? 0,
    pull_request: issue.pull_request ? true : false,
    locked: issue.locked ?? false,
    created_at: issue.created_at ?? null,
    updated_at: issue.updated_at ?? null,
    closed_at: issue.closed_at ?? null,
    closed_by: issue.closed_by?.login ?? null,
  };
}

/**
 * Build issue tracking and workflow tools.
 *
 * @param {object} client - GitHub API client (from github-client.js)
 * @param {object} sdk - Teleton plugin SDK
 * @returns {object[]} Array of tool definitions
 */
export function buildIssueTrackerTools(client, sdk) {
  return [
    // -------------------------------------------------------------------------
    // Tool: github_create_issue
    // -------------------------------------------------------------------------
    {
      name: "github_create_issue",
      description:
        "Create a new issue in a GitHub repository. " +
        "Returns the issue number, URL, and assigned labels.",
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
          if (!check.valid) return { success: false, error: check.error };

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

          return {
            success: true,
            data: formatIssue(issue),
          };
        } catch (err) {
          return { success: false, error: formatError(err) };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_list_issues
    // -------------------------------------------------------------------------
    {
      name: "github_list_issues",
      description:
        "List issues in a GitHub repository with optional filtering by state, labels, assignee, and sort order. " +
        "Note: Pull requests are also returned by GitHub's issues API — check the pull_request field to distinguish them.",
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
            description: "Filter by label names (comma-separated in API)",
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
          if (!check.valid) return { success: false, error: check.error };

          const stateVal = validateEnum(params.state, ["open", "closed", "all"], "open");
          const sortVal = validateEnum(params.sort, ["created", "updated", "comments"], "created");
          const directionVal = validateEnum(params.direction, ["asc", "desc"], "desc");

          if (!stateVal.valid) return { success: false, error: stateVal.error };
          if (!sortVal.valid) return { success: false, error: sortVal.error };
          if (!directionVal.valid) return { success: false, error: directionVal.error };

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

          const issues = Array.isArray(data) ? data.map(formatIssue) : [];

          sdk.log.info(
            `github_list_issues: fetched ${issues.length} issues from ${params.owner}/${params.repo}`
          );

          return {
            success: true,
            data: {
              issues,
              count: issues.length,
              pagination,
            },
          };
        } catch (err) {
          return { success: false, error: formatError(err) };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_comment_issue
    // -------------------------------------------------------------------------
    {
      name: "github_comment_issue",
      description:
        "Add a comment to a GitHub issue or pull request. " +
        "Returns the comment ID, URL, and creation timestamp.",
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
          if (!check.valid) return { success: false, error: check.error };

          const issueNum = Math.floor(Number(params.issue_number));
          if (!Number.isFinite(issueNum) || issueNum < 1) {
            return { success: false, error: "issue_number must be a positive integer" };
          }

          const comment = await client.post(
            `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/issues/${issueNum}/comments`,
            { body: params.body }
          );

          sdk.log.info(
            `github_comment_issue: commented on #${issueNum} in ${params.owner}/${params.repo}`
          );

          return {
            success: true,
            data: {
              id: comment.id,
              url: comment.html_url,
              body: comment.body,
              author: comment.user?.login ?? null,
              created_at: comment.created_at ?? null,
              updated_at: comment.updated_at ?? null,
            },
          };
        } catch (err) {
          return { success: false, error: formatError(err) };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_close_issue
    // -------------------------------------------------------------------------
    {
      name: "github_close_issue",
      description:
        "Close a GitHub issue or pull request, optionally adding a closing comment. " +
        "Returns the updated issue state and close timestamp.",
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
          if (!check.valid) return { success: false, error: check.error };

          const issueNum = Math.floor(Number(params.issue_number));
          if (!Number.isFinite(issueNum) || issueNum < 1) {
            return { success: false, error: "issue_number must be a positive integer" };
          }

          const reasonVal = validateEnum(
            params.reason,
            ["completed", "not_planned"],
            "completed"
          );
          if (!reasonVal.valid) return { success: false, error: reasonVal.error };

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

          return {
            success: true,
            data: formatIssue(issue),
          };
        } catch (err) {
          return { success: false, error: formatError(err) };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_trigger_workflow
    // -------------------------------------------------------------------------
    {
      name: "github_trigger_workflow",
      description:
        "Manually trigger a GitHub Actions workflow dispatch event. " +
        "The workflow must have workflow_dispatch trigger configured. " +
        "Returns a confirmation message.",
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
          if (!check.valid) return { success: false, error: check.error };

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
              success: false,
              error: `Unexpected response from GitHub Actions API: HTTP ${status}`,
            };
          }

          sdk.log.info(
            `github_trigger_workflow: triggered ${params.workflow_id} on ${params.ref} in ${params.owner}/${params.repo}`
          );

          return {
            success: true,
            data: {
              message: `Workflow '${params.workflow_id}' triggered on branch/ref '${params.ref}'.`,
              workflow_id: params.workflow_id,
              ref: params.ref,
              repository: `${params.owner}/${params.repo}`,
              inputs: params.inputs ?? {},
            },
          };
        } catch (err) {
          return { success: false, error: formatError(err) };
        }
      },
    },
  ];
}
