/**
 * Pull request management for the github-dev-assistant plugin.
 *
 * Covers:
 *  - github_create_pr          — create a new pull request
 *  - github_list_prs           — list pull requests with filtering
 *  - github_merge_pr           — merge a pull request (with require_pr_review check)
 *  - github_get_pull_request   — get full details of a specific pull request
 *
 * All tools create a fresh GitHub client per execution to pick up the latest
 * token from sdk.secrets (avoids stale client issues).
 *
 * All tools return { success, data?, error? } per the SDK ToolResult contract.
 */

import { createGitHubClient } from "./github-client.js";
import { validateRequired, validateEnum, clampInt, formatError } from "./utils.js";

/**
 * Build pull request management tools.
 *
 * @param {object} sdk - Teleton plugin SDK (for config, logging, confirm)
 * @returns {object[]} Array of tool definitions
 */
export function buildPRManagerTools(sdk) {
  return [
    // -------------------------------------------------------------------------
    // Tool: github_create_pr
    // -------------------------------------------------------------------------
    {
      name: "github_create_pr",
      description:
        "Use this when the user wants to create a pull request on GitHub. " +
        "Returns the PR number and URL.",
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
            description: "Pull request title (required)",
          },
          body: {
            type: "string",
            description: "Pull request description (Markdown supported)",
          },
          head: {
            type: "string",
            description:
              "Source branch name (required). For cross-repo PRs use 'owner:branch' format.",
          },
          base: {
            type: "string",
            description: "Target/base branch name (default: repo default branch, usually 'main')",
          },
          draft: {
            type: "boolean",
            description: "Create as draft pull request (default: false)",
          },
          maintainer_can_modify: {
            type: "boolean",
            description: "Allow maintainers to push to the head branch (default: true)",
          },
        },
        required: ["owner", "repo", "title", "head"],
      },
      execute: async (params, _context) => {
        try {
          const check = validateRequired(params, ["owner", "repo", "title", "head"]);
          if (!check.valid) return { success: false, error: check.error };

          const client = createGitHubClient(sdk);

          const base =
            params.base ??
            sdk.pluginConfig?.default_branch ??
            "main";

          const body = {
            title: params.title,
            head: params.head,
            base,
            draft: params.draft ?? false,
            maintainer_can_modify: params.maintainer_can_modify ?? true,
          };
          if (params.body) body.body = params.body;

          const pr = await client.post(
            `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/pulls`,
            body
          );

          sdk.log.info(
            `github_create_pr: created PR #${pr.number} in ${params.owner}/${params.repo}`
          );

          return {
            success: true,
            data: {
              number: pr.number,
              title: pr.title,
              html_url: pr.html_url,
              draft: pr.draft ?? false,
              head: params.head,
              base,
            },
          };
        } catch (err) {
          return { success: false, error: `Failed to create pull request: ${formatError(err)}` };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_list_prs
    // -------------------------------------------------------------------------
    {
      name: "github_list_prs",
      description:
        "Use this when the user wants to see pull requests in a GitHub repository. " +
        "Returns a formatted list of PRs with title, author, state, and URL.",
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
            description: "Filter by state (default: open)",
          },
          head: {
            type: "string",
            description:
              "Filter by head branch (use 'user:branch' format for cross-repo)",
          },
          base: {
            type: "string",
            description: "Filter by base branch",
          },
          sort: {
            type: "string",
            enum: ["created", "updated", "popularity", "long-running"],
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
      execute: async (params, _context) => {
        try {
          const check = validateRequired(params, ["owner", "repo"]);
          if (!check.valid) return { success: false, error: check.error };

          const client = createGitHubClient(sdk);

          const stateVal = validateEnum(params.state, ["open", "closed", "all"], "open");
          const sortVal = validateEnum(
            params.sort,
            ["created", "updated", "popularity", "long-running"],
            "created"
          );
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
          if (params.head) queryParams.head = params.head;
          if (params.base) queryParams.base = params.base;

          const { data, pagination } = await client.getPaginated(
            `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/pulls`,
            queryParams
          );

          const prs = Array.isArray(data) ? data : [];

          sdk.log.info(`github_list_prs: fetched ${prs.length} PRs from ${params.owner}/${params.repo}`);

          const prList = prs.map((pr) => ({
            number: pr.number,
            title: pr.title,
            state: pr.state,
            draft: pr.draft ?? false,
            author: pr.user?.login ?? null,
            labels: pr.labels?.map((l) => l.name) ?? [],
            html_url: pr.html_url,
          }));

          return {
            success: true,
            data: {
              repo: `${params.owner}/${params.repo}`,
              state: stateVal.value,
              prs: prList,
              count: prs.length,
              next_page: pagination.next ?? null,
            },
          };
        } catch (err) {
          return { success: false, error: `Failed to list pull requests: ${formatError(err)}` };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_merge_pr
    // -------------------------------------------------------------------------
    {
      name: "github_merge_pr",
      description:
        "Use this when the user wants to merge a pull request on GitHub. " +
        "Returns confirmation of the merge with the commit SHA. " +
        "When require_pr_review config is true, explicitly ask the user to confirm before calling this tool.",
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
          pr_number: {
            type: "integer",
            description: "Pull request number to merge (required)",
          },
          merge_method: {
            type: "string",
            enum: ["merge", "squash", "rebase"],
            description: "Merge strategy (default: merge)",
          },
          commit_title: {
            type: "string",
            description: "Custom commit title for merge/squash commits",
          },
          commit_message: {
            type: "string",
            description: "Custom commit message body for merge/squash commits",
          },
          confirmed: {
            type: "boolean",
            description:
              "Set to true when the user has explicitly confirmed they want to merge. " +
              "Required when require_pr_review config option is enabled.",
          },
        },
        required: ["owner", "repo", "pr_number"],
      },
      execute: async (params, _context) => {
        try {
          const check = validateRequired(params, ["owner", "repo", "pr_number"]);
          if (!check.valid) return { success: false, error: check.error };

          const client = createGitHubClient(sdk);

          const prNum = Math.floor(Number(params.pr_number));
          if (!Number.isFinite(prNum) || prNum < 1) {
            return { success: false, error: "pr_number must be a positive integer" };
          }

          const mergeMethodVal = validateEnum(
            params.merge_method,
            ["merge", "squash", "rebase"],
            "merge"
          );
          if (!mergeMethodVal.valid) return { success: false, error: mergeMethodVal.error };

          // Security policy: check require_pr_review
          // Since sdk.llm.confirm() does not exist in the SDK, the confirmation
          // is handled by the LLM itself — it should ask the user before calling
          // this tool when require_pr_review is enabled. The `confirmed` param
          // signals that the user has explicitly approved the merge.
          const requireReview = sdk.pluginConfig?.require_pr_review ?? false;
          const confirmed = params.confirmed ?? false;

          if (requireReview && !confirmed) {
            // Fetch PR details so the LLM can surface them in the confirmation prompt
            let prTitle = `PR #${prNum}`;
            try {
              const prData = await client.get(
                `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/pulls/${prNum}`
              );
              prTitle = `PR #${prNum}: ${prData.title}`;
            } catch {
              // Non-fatal — use generic title
            }

            return {
              success: false,
              error:
                `The require_pr_review policy is enabled. Please ask the user to explicitly confirm ` +
                `they want to merge ${prTitle} in ${params.owner}/${params.repo} ` +
                `using the ${mergeMethodVal.value} strategy, ` +
                `then call this tool again with confirmed=true.`,
            };
          }

          const body = {
            merge_method: mergeMethodVal.value,
          };
          if (params.commit_title) body.commit_title = params.commit_title;
          if (params.commit_message) body.commit_message = params.commit_message;

          const result = await client.put(
            `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/pulls/${prNum}/merge`,
            body
          );

          sdk.log.info(
            `github_merge_pr: merged PR #${prNum} in ${params.owner}/${params.repo} via ${mergeMethodVal.value}`
          );

          return {
            success: true,
            data: {
              pr_number: prNum,
              repo: `${params.owner}/${params.repo}`,
              merge_method: mergeMethodVal.value,
              sha: result.sha ?? null,
              message: result.message ?? "Merged successfully.",
            },
          };
        } catch (err) {
          return { success: false, error: `Failed to merge pull request: ${formatError(err)}` };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_get_pull_request
    // -------------------------------------------------------------------------
    {
      name: "github_get_pull_request",
      description:
        "Use this when the user wants to get detailed information about a specific pull request on GitHub. " +
        "Returns the PR title, body, state, author, labels, head/base branches, review status, and more.",
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
          pull_number: {
            type: "integer",
            description: "Pull request number",
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

          const client = createGitHubClient(sdk);

          const pr = await client.get(
            `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/pulls/${prNumber}`
          );

          sdk.log.info(
            `github_get_pull_request: fetched PR #${prNumber} from ${params.owner}/${params.repo}`
          );

          return {
            success: true,
            data: {
              number: pr.number,
              title: pr.title,
              body: pr.body ?? null,
              state: pr.state,
              draft: pr.draft ?? false,
              merged: pr.merged ?? false,
              mergeable: pr.mergeable ?? null,
              mergeable_state: pr.mergeable_state ?? null,
              author: pr.user?.login ?? null,
              assignees: (pr.assignees ?? []).map((a) => a.login),
              labels: (pr.labels ?? []).map((l) => l.name),
              head: {
                ref: pr.head?.ref ?? null,
                sha: pr.head?.sha ?? null,
                repo: pr.head?.repo?.full_name ?? null,
              },
              base: {
                ref: pr.base?.ref ?? null,
                sha: pr.base?.sha ?? null,
                repo: pr.base?.repo?.full_name ?? null,
              },
              html_url: pr.html_url,
              commits: pr.commits ?? null,
              additions: pr.additions ?? null,
              deletions: pr.deletions ?? null,
              changed_files: pr.changed_files ?? null,
              created_at: pr.created_at,
              updated_at: pr.updated_at,
              closed_at: pr.closed_at ?? null,
              merged_at: pr.merged_at ?? null,
              merged_by: pr.merged_by?.login ?? null,
              review_decision: pr.review_decision ?? null,
              requested_reviewers: (pr.requested_reviewers ?? []).map((r) => r.login),
            },
          };
        } catch (err) {
          return { success: false, error: `Failed to get pull request: ${formatError(err)}` };
        }
      },
    },
  ];
}
