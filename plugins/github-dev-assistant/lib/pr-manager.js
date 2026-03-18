/**
 * Pull request management for the github-dev-assistant plugin.
 *
 * Covers:
 *  - github_create_pr  — create a new pull request
 *  - github_list_prs   — list pull requests with filtering
 *  - github_merge_pr   — merge a pull request (with require_pr_review check)
 *
 * All tools create a fresh GitHub client per execution to pick up the latest
 * token from sdk.secrets (avoids stale client issues).
 *
 * All tools return { content: string } for direct LLM consumption.
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
      execute: async (params) => {
        try {
          const check = validateRequired(params, ["owner", "repo", "title", "head"]);
          if (!check.valid) return { content: `Error: ${check.error}` };

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

          const draftLabel = pr.draft ? " (draft)" : "";
          return {
            content:
              `Pull request #${pr.number} created${draftLabel}: **${pr.title}**\n` +
              `From \`${params.head}\` → \`${base}\`\n` +
              `URL: ${pr.html_url}`,
          };
        } catch (err) {
          return { content: `Failed to create pull request: ${formatError(err)}` };
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
      execute: async (params) => {
        try {
          const check = validateRequired(params, ["owner", "repo"]);
          if (!check.valid) return { content: `Error: ${check.error}` };

          const client = createGitHubClient(sdk);

          const stateVal = validateEnum(params.state, ["open", "closed", "all"], "open");
          const sortVal = validateEnum(
            params.sort,
            ["created", "updated", "popularity", "long-running"],
            "created"
          );
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
          if (params.head) queryParams.head = params.head;
          if (params.base) queryParams.base = params.base;

          const { data, pagination } = await client.getPaginated(
            `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/pulls`,
            queryParams
          );

          const prs = Array.isArray(data) ? data : [];

          sdk.log.info(`github_list_prs: fetched ${prs.length} PRs from ${params.owner}/${params.repo}`);

          if (prs.length === 0) {
            return { content: `No ${stateVal.value} pull requests found in ${params.owner}/${params.repo}.` };
          }

          const lines = prs.map((pr) => {
            const draft = pr.draft ? " [draft]" : "";
            const labels = pr.labels?.length ? ` [${pr.labels.map((l) => l.name).join(", ")}]` : "";
            return `- #${pr.number} **${pr.title}**${draft}${labels} by @${pr.user?.login ?? "unknown"}\n  ${pr.html_url}`;
          });

          const pageInfo =
            pagination.next
              ? `\n\nPage ${page} of results. Use page=${pagination.next} to get more.`
              : "";

          return {
            content:
              `${stateVal.value.charAt(0).toUpperCase() + stateVal.value.slice(1)} pull requests in **${params.owner}/${params.repo}** (${prs.length} shown):\n\n` +
              lines.join("\n") +
              pageInfo,
          };
        } catch (err) {
          return { content: `Failed to list pull requests: ${formatError(err)}` };
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
        "Returns confirmation of the merge with the commit SHA.",
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
          if (!check.valid) return { content: `Error: ${check.error}` };

          const client = createGitHubClient(sdk);

          const prNum = Math.floor(Number(params.pr_number));
          if (!Number.isFinite(prNum) || prNum < 1) {
            return { content: "Error: pr_number must be a positive integer" };
          }

          const mergeMethodVal = validateEnum(
            params.merge_method,
            ["merge", "squash", "rebase"],
            "merge"
          );
          if (!mergeMethodVal.valid) return { content: `Error: ${mergeMethodVal.error}` };

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
                content: "Merge cancelled. The require_pr_review policy requires explicit confirmation before merging.",
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

          const sha = result.sha ? ` (${result.sha.slice(0, 7)})` : "";
          return {
            content:
              `Pull request #${prNum} merged successfully via ${mergeMethodVal.value}${sha}.\n` +
              (result.message ? result.message : ""),
          };
        } catch (err) {
          return { content: `Failed to merge pull request: ${formatError(err)}` };
        }
      },
    },
  ];
}
