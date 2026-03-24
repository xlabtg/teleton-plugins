/**
 * Extended pull request and issue search operations for the github-dev-assistant plugin.
 *
 * Covers:
 *  - github_search_issues    — search issues and PRs using GitHub search syntax
 *  - github_update_pr        — update a pull request (title, body, state, base)
 *  - github_add_pr_review    — submit a review on a pull request
 *  - github_get_job_logs     — get logs for a specific workflow job
 *
 * All tools create a fresh GitHub client per execution to pick up the latest
 * token from sdk.secrets (avoids stale client issues).
 *
 * All tools return { success, data?, error? } per the SDK ToolResult contract.
 */

import { createGitHubClient } from "./github-client.js";
import { validateRequired, clampInt, formatError } from "./utils.js";

/**
 * Build extended pull request and issue search tools.
 *
 * @param {object} sdk - Teleton plugin SDK (for config, logging, secrets)
 * @returns {object[]} Array of tool definitions
 */
export function buildExtendedPROpsTools(sdk) {
  return [
    // -------------------------------------------------------------------------
    // Tool: github_search_issues
    // -------------------------------------------------------------------------
    {
      name: "github_search_issues",
      description:
        "Use this when the user wants to search for issues or pull requests across GitHub using search qualifiers. " +
        "Supports GitHub search syntax like 'is:issue is:open label:bug repo:owner/repo'. " +
        "Returns matching issues/PRs with titles, states, and labels.",
      category: "data-bearing",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query using GitHub issue search syntax (e.g. 'is:issue is:open label:bug repo:owner/repo')",
          },
          sort: {
            type: "string",
            enum: ["comments", "reactions", "reactions-+1", "reactions--1", "reactions-smile", "reactions-thinking_face", "reactions-heart", "reactions-tada", "interactions", "created", "updated"],
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

          const { data, pagination } = await client.getPaginated("/search/issues", queryParams);

          const items = Array.isArray(data?.items) ? data.items : [];

          sdk.log.info(
            `github_search_issues: found ${data?.total_count ?? 0} results for "${params.query}"`
          );

          const results = items.map((i) => ({
            number: i.number,
            title: i.title,
            state: i.state,
            type: i.pull_request ? "pull_request" : "issue",
            html_url: i.html_url,
            user: i.user?.login ?? null,
            labels: (i.labels ?? []).map((l) => l.name),
            comments: i.comments,
            created_at: i.created_at,
            updated_at: i.updated_at,
            body_preview: i.body ? i.body.slice(0, 200) : null,
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
          return { success: false, error: `Failed to search issues: ${formatError(err)}` };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_update_pr
    // -------------------------------------------------------------------------
    {
      name: "github_update_pr",
      description:
        "Use this when the user wants to update a pull request — change its title, body, state (open/closed), or base branch. " +
        "Returns the updated pull request details.",
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
          pull_number: {
            type: "integer",
            description: "Pull request number to update",
          },
          title: {
            type: "string",
            description: "New title for the pull request (optional)",
          },
          body: {
            type: "string",
            description: "New description/body for the pull request (optional)",
          },
          state: {
            type: "string",
            enum: ["open", "closed"],
            description: "New state for the pull request (optional)",
          },
          base: {
            type: "string",
            description: "New base branch to merge into (optional)",
          },
          maintainer_can_modify: {
            type: "boolean",
            description: "Whether maintainers can modify the PR (optional)",
          },
        },
        required: ["owner", "repo", "pull_number"],
      },
      execute: async (params, _context) => {
        try {
          const check = validateRequired(params, ["owner", "repo", "pull_number"]);
          if (!check.valid) return { success: false, error: check.error };

          const prNumber = Math.floor(Number(params.pull_number));
          if (!Number.isFinite(prNumber) || prNumber < 1) {
            return { success: false, error: "pull_number must be a positive integer" };
          }

          const body = {};
          if (params.title !== undefined) body.title = params.title;
          if (params.body !== undefined) body.body = params.body;
          if (params.state !== undefined) body.state = params.state;
          if (params.base !== undefined) body.base = params.base;
          if (params.maintainer_can_modify !== undefined) body.maintainer_can_modify = params.maintainer_can_modify;

          if (Object.keys(body).length === 0) {
            return { success: false, error: "At least one field to update must be provided (title, body, state, base, or maintainer_can_modify)" };
          }

          const client = createGitHubClient(sdk);

          const result = await client.patch(
            `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/pulls/${prNumber}`,
            body
          );

          sdk.log.info(
            `github_update_pr: updated PR #${prNumber} in ${params.owner}/${params.repo}`
          );

          return {
            success: true,
            data: {
              number: result?.number ?? prNumber,
              title: result?.title ?? null,
              state: result?.state ?? null,
              html_url: result?.html_url ?? null,
              base: result?.base?.ref ?? null,
              message: `Pull request #${prNumber} updated successfully.`,
            },
          };
        } catch (err) {
          return { success: false, error: `Failed to update pull request: ${formatError(err)}` };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_add_pr_review
    // -------------------------------------------------------------------------
    {
      name: "github_add_pr_review",
      description:
        "Use this when the user wants to submit a review on a pull request — approve, request changes, or leave a comment. " +
        "Returns the review details.",
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
          pull_number: {
            type: "integer",
            description: "Pull request number to review",
          },
          event: {
            type: "string",
            enum: ["APPROVE", "REQUEST_CHANGES", "COMMENT"],
            description: "Review action: APPROVE, REQUEST_CHANGES, or COMMENT",
          },
          body: {
            type: "string",
            description: "Review comment body (required for REQUEST_CHANGES and COMMENT, optional for APPROVE)",
          },
          commit_id: {
            type: "string",
            description: "SHA of the commit to review (defaults to the PR's latest commit)",
          },
        },
        required: ["owner", "repo", "pull_number", "event"],
      },
      execute: async (params, _context) => {
        try {
          const check = validateRequired(params, ["owner", "repo", "pull_number", "event"]);
          if (!check.valid) return { success: false, error: check.error };

          const prNumber = Math.floor(Number(params.pull_number));
          if (!Number.isFinite(prNumber) || prNumber < 1) {
            return { success: false, error: "pull_number must be a positive integer" };
          }

          const allowedEvents = ["APPROVE", "REQUEST_CHANGES", "COMMENT"];
          if (!allowedEvents.includes(params.event)) {
            return { success: false, error: `event must be one of: ${allowedEvents.join(", ")}` };
          }

          if ((params.event === "REQUEST_CHANGES" || params.event === "COMMENT") && !params.body) {
            return { success: false, error: `body is required when event is ${params.event}` };
          }

          const client = createGitHubClient(sdk);

          const requestBody = { event: params.event };
          if (params.body) requestBody.body = params.body;
          if (params.commit_id) requestBody.commit_id = params.commit_id;

          const result = await client.post(
            `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/pulls/${prNumber}/reviews`,
            requestBody
          );

          sdk.log.info(
            `github_add_pr_review: submitted ${params.event} review on PR #${prNumber} in ${params.owner}/${params.repo}`
          );

          return {
            success: true,
            data: {
              id: result?.id ?? null,
              pull_number: prNumber,
              repo: `${params.owner}/${params.repo}`,
              state: result?.state ?? params.event,
              user: result?.user?.login ?? null,
              html_url: result?.html_url ?? null,
              message: `Review (${params.event}) submitted on PR #${prNumber}.`,
            },
          };
        } catch (err) {
          return { success: false, error: `Failed to submit PR review: ${formatError(err)}` };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_get_job_logs
    // -------------------------------------------------------------------------
    {
      name: "github_get_job_logs",
      description:
        "Use this when the user wants to see the logs for a specific GitHub Actions workflow job. " +
        "Returns the log URL or log content for debugging workflow failures.",
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
          job_id: {
            type: "integer",
            description: "Workflow job ID (get from github_list_workflow_runs)",
          },
        },
        required: ["owner", "repo", "job_id"],
      },
      execute: async (params, _context) => {
        try {
          const check = validateRequired(params, ["owner", "repo", "job_id"]);
          if (!check.valid) return { success: false, error: check.error };

          const jobId = Math.floor(Number(params.job_id));
          if (!Number.isFinite(jobId) || jobId < 1) {
            return { success: false, error: "job_id must be a positive integer" };
          }

          const client = createGitHubClient(sdk);

          // First get job details
          const job = await client.get(
            `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/actions/jobs/${jobId}`
          );

          sdk.log.info(
            `github_get_job_logs: fetched job ${jobId} details in ${params.owner}/${params.repo}`
          );

          // The logs endpoint returns a redirect to a download URL (302)
          // Return the job details with the logs URL
          return {
            success: true,
            data: {
              job_id: job?.id ?? jobId,
              repo: `${params.owner}/${params.repo}`,
              name: job?.name ?? null,
              status: job?.status ?? null,
              conclusion: job?.conclusion ?? null,
              started_at: job?.started_at ?? null,
              completed_at: job?.completed_at ?? null,
              html_url: job?.html_url ?? null,
              logs_url: `https://api.github.com/repos/${params.owner}/${params.repo}/actions/jobs/${jobId}/logs`,
              steps: (job?.steps ?? []).map((s) => ({
                name: s.name,
                status: s.status,
                conclusion: s.conclusion ?? null,
                number: s.number,
                started_at: s.started_at ?? null,
                completed_at: s.completed_at ?? null,
              })),
            },
          };
        } catch (err) {
          return { success: false, error: `Failed to get job logs: ${formatError(err)}` };
        }
      },
    },
  ];
}
