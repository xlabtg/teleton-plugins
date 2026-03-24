/**
 * Label operations for the github-dev-assistant plugin.
 *
 * Covers:
 *  - github_list_labels  — list labels in a repository
 *  - github_create_label — create a new label
 *  - github_delete_label — delete a label
 *
 * All tools create a fresh GitHub client per execution to pick up the latest
 * token from sdk.secrets (avoids stale client issues).
 *
 * All tools return { success, data?, error? } per the SDK ToolResult contract.
 */

import { createGitHubClient } from "./github-client.js";
import { validateRequired, clampInt, formatError } from "./utils.js";

/**
 * Build label operation tools.
 *
 * @param {object} sdk - Teleton plugin SDK
 * @returns {object[]} Array of tool definitions
 */
export function buildLabelOpsTools(sdk) {
  return [
    // -------------------------------------------------------------------------
    // Tool: github_list_labels
    // -------------------------------------------------------------------------
    {
      name: "github_list_labels",
      description:
        "Use this when the user wants to see all labels available in a GitHub repository. " +
        "Returns a list of labels with their names, colors, and descriptions.",
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
            `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/labels`,
            { per_page: perPage, page }
          );

          const labels = Array.isArray(data) ? data : [];

          sdk.log.info(
            `github_list_labels: fetched ${labels.length} labels in ${params.owner}/${params.repo}`
          );

          const labelList = labels.map((l) => ({
            id: l.id,
            name: l.name,
            color: l.color,
            description: l.description ?? null,
            default: l.default ?? false,
            url: l.url,
          }));

          return {
            success: true,
            data: {
              repo: `${params.owner}/${params.repo}`,
              labels: labelList,
              count: labelList.length,
              next_page: pagination.next ?? null,
            },
          };
        } catch (err) {
          return { success: false, error: `Failed to list labels: ${formatError(err)}` };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_create_label
    // -------------------------------------------------------------------------
    {
      name: "github_create_label",
      description:
        "Use this when the user wants to create a new label in a GitHub repository. " +
        "Returns the created label details.",
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
          name: {
            type: "string",
            description: "Label name (required)",
          },
          color: {
            type: "string",
            description: "6-character hex color code without '#' (e.g. 'FF5733' for red-orange)",
          },
          description: {
            type: "string",
            description: "Short description of what the label represents (optional)",
          },
        },
        required: ["owner", "repo", "name", "color"],
      },
      execute: async (params, _context) => {
        try {
          const check = validateRequired(params, ["owner", "repo", "name", "color"]);
          if (!check.valid) return { success: false, error: check.error };

          // Strip leading '#' if user included it
          const color = params.color.replace(/^#/, "");
          if (!/^[0-9A-Fa-f]{6}$/.test(color)) {
            return {
              success: false,
              error: "color must be a valid 6-character hex code (e.g. 'FF5733'). Do not include '#'.",
            };
          }

          const client = createGitHubClient(sdk);

          const body = {
            name: params.name,
            color,
          };
          if (params.description) body.description = params.description;

          const label = await client.post(
            `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/labels`,
            body
          );

          sdk.log.info(
            `github_create_label: created label "${params.name}" in ${params.owner}/${params.repo}`
          );

          return {
            success: true,
            data: {
              id: label.id,
              name: label.name,
              color: label.color,
              description: label.description ?? null,
              repo: `${params.owner}/${params.repo}`,
            },
          };
        } catch (err) {
          return { success: false, error: `Failed to create label: ${formatError(err)}` };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_delete_label
    // -------------------------------------------------------------------------
    {
      name: "github_delete_label",
      description:
        "Use this when the user wants to delete a label from a GitHub repository. " +
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
          name: {
            type: "string",
            description: "Label name to delete (required)",
          },
        },
        required: ["owner", "repo", "name"],
      },
      execute: async (params, _context) => {
        try {
          const check = validateRequired(params, ["owner", "repo", "name"]);
          if (!check.valid) return { success: false, error: check.error };

          const client = createGitHubClient(sdk);

          await client.delete(
            `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/labels/${encodeURIComponent(params.name)}`
          );

          sdk.log.info(
            `github_delete_label: deleted label "${params.name}" from ${params.owner}/${params.repo}`
          );

          return {
            success: true,
            data: {
              name: params.name,
              repo: `${params.owner}/${params.repo}`,
              message: `Label "${params.name}" deleted successfully.`,
            },
          };
        } catch (err) {
          return { success: false, error: `Failed to delete label: ${formatError(err)}` };
        }
      },
    },
  ];
}
