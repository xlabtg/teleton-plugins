/**
 * Pull request management for the github-dev-assistant plugin.
 *
 * Covers:
 *  - github_create_pr  — create a new pull request
 *  - github_list_prs   — list pull requests with filtering
 *  - github_merge_pr   — merge a pull request (with require_pr_review check)
 */

import { validateRequired, validateEnum, clampInt, formatError } from "./utils.js";

/**
 * Format a pull request object to a clean, consistent shape.
 * @param {object} pr - Raw GitHub PR object
 * @returns {object}
 */
function formatPR(pr) {
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body ?? null,
    state: pr.state,
    draft: pr.draft ?? false,
    url: pr.html_url,
    head: pr.head?.label ?? null,
    head_sha: pr.head?.sha ?? null,
    base: pr.base?.label ?? null,
    author: pr.user?.login ?? null,
    assignees: (pr.assignees ?? []).map((a) => a.login),
    labels: (pr.labels ?? []).map((l) => l.name),
    requested_reviewers: (pr.requested_reviewers ?? []).map((r) => r.login),
    mergeable: pr.mergeable ?? null,
    mergeable_state: pr.mergeable_state ?? null,
    merged: pr.merged ?? false,
    merged_at: pr.merged_at ?? null,
    merge_commit_sha: pr.merge_commit_sha ?? null,
    commits: pr.commits ?? null,
    additions: pr.additions ?? null,
    deletions: pr.deletions ?? null,
    changed_files: pr.changed_files ?? null,
    created_at: pr.created_at ?? null,
    updated_at: pr.updated_at ?? null,
    closed_at: pr.closed_at ?? null,
  };
}

/**
 * Build pull request management tools.
 *
 * @param {object} client - GitHub API client (from github-client.js)
 * @param {object} sdk - Teleton plugin SDK (for config, logging, confirm)
 * @returns {object[]} Array of tool definitions
 */
export function buildPRManagerTools(client, sdk) {
  return [
    // -------------------------------------------------------------------------
    // Tool: github_create_pr
    // -------------------------------------------------------------------------
    {
      name: "github_create_pr",
      description:
        "Create a new pull request in a GitHub repository. " +
        "Requires at least a title, source branch (head), and target branch (base). " +
        "Returns the PR number, URL, and state.",
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
      execute: async (params) => {
        try {
          const check = validateRequired(params, ["owner", "repo", "title", "head"]);
          if (!check.valid) return { success: false, error: check.error };

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
            data: formatPR(pr),
          };
        } catch (err) {
          return { success: false, error: formatError(err) };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_list_prs
    // -------------------------------------------------------------------------
    {
      name: "github_list_prs",
      description:
        "List pull requests in a GitHub repository with optional filtering by state, branch, and sort order. " +
        "Returns PR metadata including title, author, labels, and state.",
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
      execute: async (params) => {
        try {
          const check = validateRequired(params, ["owner", "repo"]);
          if (!check.valid) return { success: false, error: check.error };

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

          const prs = Array.isArray(data) ? data.map(formatPR) : [];

          sdk.log.info(`github_list_prs: fetched ${prs.length} PRs from ${params.owner}/${params.repo}`);

          return {
            success: true,
            data: {
              prs,
              count: prs.length,
              pagination,
            },
          };
        } catch (err) {
          return { success: false, error: formatError(err) };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_merge_pr
    // -------------------------------------------------------------------------
    {
      name: "github_merge_pr",
      description:
        "Merge a pull request. Checks the require_pr_review configuration policy before merging — " +
        "if enabled, will ask for user confirmation unless skip_review_check is true. " +
        "Returns the merge commit SHA and merged status.",
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
          skip_review_check: {
            type: "boolean",
            description:
              "Skip the require_pr_review confirmation check (default: false). " +
              "Only use when the user has explicitly pre-approved the merge.",
          },
        },
        required: ["owner", "repo", "pr_number"],
      },
      execute: async (params) => {
        try {
          const check = validateRequired(params, ["owner", "repo", "pr_number"]);
          if (!check.valid) return { success: false, error: check.error };

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
          const requireReview = sdk.pluginConfig?.require_pr_review ?? false;
          const skipCheck = params.skip_review_check ?? false;

          if (requireReview && !skipCheck) {
            // Fetch PR details for the confirmation prompt
            let prTitle = `PR #${prNum}`;
            try {
              const prData = await client.get(
                `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/pulls/${prNum}`
              );
              prTitle = `PR #${prNum}: ${prData.title}`;
            } catch {
              // Non-fatal — use generic title
            }

            // Request explicit user confirmation via sdk
            const confirmed = await sdk.llm?.confirm?.(
              `⚠️ You are about to merge **${prTitle}** in \`${params.owner}/${params.repo}\` ` +
              `using the **${mergeMethodVal.value}** strategy.\n\nProceed with merge?`
            );

            if (!confirmed) {
              return {
                success: false,
                error: "Merge cancelled by user (require_pr_review policy).",
              };
            }
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
              merged: result.merged ?? true,
              sha: result.sha ?? null,
              message: result.message ?? "Pull request merged successfully",
              pr_number: prNum,
              merge_method: mergeMethodVal.value,
            },
          };
        } catch (err) {
          return { success: false, error: formatError(err) };
        }
      },
    },
  ];
}
