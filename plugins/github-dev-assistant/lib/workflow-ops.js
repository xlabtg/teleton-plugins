/**
 * Extended GitHub Actions workflow operations for the github-dev-assistant plugin.
 *
 * Covers:
 *  - github_list_workflows      — list GitHub Actions workflows in a repository
 *  - github_list_workflow_runs  — list runs of workflows
 *  - github_cancel_workflow_run — cancel a running workflow run
 *
 * All tools create a fresh GitHub client per execution to pick up the latest
 * token from sdk.secrets (avoids stale client issues).
 *
 * All tools return { success, data?, error? } per the SDK ToolResult contract.
 */

import { createGitHubClient } from "./github-client.js";
import { validateRequired, clampInt, formatError } from "./utils.js";

/**
 * Build extended workflow operation tools.
 *
 * @param {object} sdk - Teleton plugin SDK
 * @returns {object[]} Array of tool definitions
 */
export function buildWorkflowOpsTools(sdk) {
  return [
    // -------------------------------------------------------------------------
    // Tool: github_list_workflows
    // -------------------------------------------------------------------------
    {
      name: "github_list_workflows",
      description:
        "Use this when the user wants to see all GitHub Actions workflows in a repository. " +
        "Returns a list of workflows with their IDs, names, and state.",
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
            `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/actions/workflows`,
            { per_page: perPage, page }
          );

          const workflows = Array.isArray(data?.workflows) ? data.workflows : [];

          sdk.log.info(
            `github_list_workflows: fetched ${workflows.length} workflows in ${params.owner}/${params.repo}`
          );

          const workflowList = workflows.map((w) => ({
            id: w.id,
            name: w.name,
            path: w.path,
            state: w.state,
            html_url: w.html_url,
          }));

          return {
            success: true,
            data: {
              repo: `${params.owner}/${params.repo}`,
              workflows: workflowList,
              count: workflowList.length,
              total_count: data?.total_count ?? workflowList.length,
              next_page: pagination.next ?? null,
            },
          };
        } catch (err) {
          return { success: false, error: `Failed to list workflows: ${formatError(err)}` };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_list_workflow_runs
    // -------------------------------------------------------------------------
    {
      name: "github_list_workflow_runs",
      description:
        "Use this when the user wants to see recent runs of GitHub Actions workflows in a repository. " +
        "Optionally filter by a specific workflow ID or filename. " +
        "Returns a list of runs with status, conclusion, and branch.",
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
          workflow_id: {
            type: "string",
            description: "Workflow file name (e.g. 'ci.yml') or numeric workflow ID to filter runs (optional)",
          },
          branch: {
            type: "string",
            description: "Filter runs by branch name (optional)",
          },
          status: {
            type: "string",
            enum: ["completed", "action_required", "cancelled", "failure", "neutral", "skipped", "stale", "success", "timed_out", "in_progress", "queued", "requested", "waiting", "pending"],
            description: "Filter by run status (optional)",
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
          if (params.branch) queryParams.branch = params.branch;
          if (params.status) queryParams.status = params.status;

          let apiPath;
          if (params.workflow_id) {
            apiPath = `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/actions/workflows/${encodeURIComponent(params.workflow_id)}/runs`;
          } else {
            apiPath = `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/actions/runs`;
          }

          const { data, pagination } = await client.getPaginated(apiPath, queryParams);

          const runs = Array.isArray(data?.workflow_runs) ? data.workflow_runs : [];

          sdk.log.info(
            `github_list_workflow_runs: fetched ${runs.length} runs in ${params.owner}/${params.repo}`
          );

          const runList = runs.map((r) => ({
            id: r.id,
            name: r.name,
            workflow_id: r.workflow_id,
            head_branch: r.head_branch,
            head_sha: r.head_sha?.slice(0, 7) ?? null,
            status: r.status,
            conclusion: r.conclusion ?? null,
            created_at: r.created_at,
            updated_at: r.updated_at,
            html_url: r.html_url,
          }));

          return {
            success: true,
            data: {
              repo: `${params.owner}/${params.repo}`,
              workflow_id: params.workflow_id ?? null,
              runs: runList,
              count: runList.length,
              total_count: data?.total_count ?? runList.length,
              next_page: pagination.next ?? null,
            },
          };
        } catch (err) {
          return { success: false, error: `Failed to list workflow runs: ${formatError(err)}` };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_cancel_workflow_run
    // -------------------------------------------------------------------------
    {
      name: "github_cancel_workflow_run",
      description:
        "Use this when the user wants to cancel a currently running GitHub Actions workflow run. " +
        "Returns a confirmation on success.",
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
          run_id: {
            type: "integer",
            description: "Workflow run ID to cancel (required, get from github_list_workflow_runs)",
          },
        },
        required: ["owner", "repo", "run_id"],
      },
      execute: async (params, _context) => {
        try {
          const check = validateRequired(params, ["owner", "repo", "run_id"]);
          if (!check.valid) return { success: false, error: check.error };

          const runId = Math.floor(Number(params.run_id));
          if (!Number.isFinite(runId) || runId < 1) {
            return { success: false, error: "run_id must be a positive integer" };
          }

          const client = createGitHubClient(sdk);

          const { status } = await client.postRaw(
            `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/actions/runs/${runId}/cancel`,
            {}
          );

          if (status !== 202) {
            return {
              success: false,
              error: `Unexpected response from GitHub (HTTP ${status}). The run may have already completed.`,
            };
          }

          sdk.log.info(
            `github_cancel_workflow_run: cancelled run ${runId} in ${params.owner}/${params.repo}`
          );

          return {
            success: true,
            data: {
              run_id: runId,
              repo: `${params.owner}/${params.repo}`,
              message: `Workflow run ${runId} cancellation requested.`,
            },
          };
        } catch (err) {
          return { success: false, error: `Failed to cancel workflow run: ${formatError(err)}` };
        }
      },
    },
  ];
}
