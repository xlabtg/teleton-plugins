/**
 * Extended file operations for the github-dev-assistant plugin.
 *
 * Covers:
 *  - github_delete_file     — delete a file from a repository
 *  - github_list_directory  — list contents of a directory
 *  - github_list_files      — alias for github_list_directory with identical behaviour
 *  - github_search_code     — search for code patterns in a repository
 *  - github_download_file   — download a file and optionally save it locally
 *
 * All tools create a fresh GitHub client per execution to pick up the latest
 * token from sdk.secrets (avoids stale client issues).
 *
 * All tools return { success, data?, error? } per the SDK ToolResult contract.
 */

import { resolve, isAbsolute, normalize } from "node:path";
import { createGitHubClient } from "./github-client.js";
import { decodeBase64, validateRequired, formatError } from "./utils.js";

/**
 * Validate that a local file path is safe to write to.
 *
 * Rules:
 *  1. Must be an absolute path (no relative paths like "../../etc/passwd").
 *  2. After resolving, must not escape the allowed root directory.
 *
 * @param {string} filePath - The path supplied by the caller.
 * @param {string} allowedRoot - The directory the resolved path must be under.
 * @returns {{ valid: boolean, error?: string, resolved?: string }}
 */
function validateSavePath(filePath, allowedRoot) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    return { valid: false, error: "save_to_file must be a non-empty string." };
  }

  if (!isAbsolute(filePath)) {
    return {
      valid: false,
      error: `save_to_file must be an absolute path (got: "${filePath}"). Relative paths are not allowed.`,
    };
  }

  const resolvedFile = resolve(normalize(filePath));
  const resolvedRoot = resolve(allowedRoot);

  if (!resolvedFile.startsWith(resolvedRoot + "/") && resolvedFile !== resolvedRoot) {
    return {
      valid: false,
      error: `save_to_file path "${filePath}" is outside the allowed directory "${allowedRoot}". Files may only be saved under that directory.`,
    };
  }

  return { valid: true, resolved: resolvedFile };
}

/**
 * Build extended file operation tools.
 *
 * @param {object} sdk - Teleton plugin SDK (for config, logging, secrets)
 * @returns {object[]} Array of tool definitions
 */
export function buildFileOpsTools(sdk) {
  return [
    // -------------------------------------------------------------------------
    // Tool: github_delete_file
    // -------------------------------------------------------------------------
    {
      name: "github_delete_file",
      description:
        "Use this when the user wants to delete a file from a GitHub repository. " +
        "Requires the file SHA (get it via github_get_file first). " +
        "Returns a confirmation with the commit URL.",
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
          path: {
            type: "string",
            description: "Path to the file within the repo (e.g. 'src/old-file.js')",
          },
          message: {
            type: "string",
            description: "Commit message for the deletion",
          },
          sha: {
            type: "string",
            description: "Current file SHA — required, get via github_get_file",
          },
          branch: {
            type: "string",
            description: "Branch to delete from (defaults to the repo's default branch)",
          },
          committer_name: {
            type: "string",
            description: "Committer name (defaults to plugin config commit_author_name)",
          },
          committer_email: {
            type: "string",
            description: "Committer email (defaults to plugin config commit_author_email)",
          },
        },
        required: ["owner", "repo", "path", "message", "sha"],
      },
      execute: async (params, _context) => {
        try {
          const check = validateRequired(params, ["owner", "repo", "path", "message", "sha"]);
          if (!check.valid) return { success: false, error: check.error };

          const client = createGitHubClient(sdk);

          const authorName =
            params.committer_name ??
            sdk.pluginConfig?.commit_author_name ??
            "Teleton AI Agent";
          const authorEmail =
            params.committer_email ??
            sdk.pluginConfig?.commit_author_email ??
            "agent@teleton.local";

          const body = {
            message: params.message,
            sha: params.sha,
            committer: { name: authorName, email: authorEmail },
          };

          if (params.branch) body.branch = params.branch;

          const result = await client.delete(
            `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/contents/${params.path}`,
            body
          );

          sdk.log.info(
            `github_delete_file: deleted ${params.path} in ${params.owner}/${params.repo}`
          );

          return {
            success: true,
            data: {
              path: params.path,
              repo: `${params.owner}/${params.repo}`,
              commit_sha: result?.commit?.sha ?? null,
              commit_url: result?.commit?.html_url ?? null,
              message: `File ${params.path} deleted successfully.`,
            },
          };
        } catch (err) {
          return { success: false, error: `Failed to delete file: ${formatError(err)}` };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_list_directory
    // -------------------------------------------------------------------------
    {
      name: "github_list_directory",
      description:
        "Use this when the user wants to browse or list the contents of a directory in a GitHub repository. " +
        "Returns a list of files and subdirectories with their types and sizes.",
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
          path: {
            type: "string",
            description: "Directory path within the repo (default: repo root '')",
          },
          ref: {
            type: "string",
            description: "Branch, tag, or commit SHA to list from (default: repo default branch)",
          },
        },
        required: ["owner", "repo"],
      },
      execute: async (params, _context) => {
        try {
          const check = validateRequired(params, ["owner", "repo"]);
          if (!check.valid) return { success: false, error: check.error };

          const client = createGitHubClient(sdk);
          const queryParams = {};
          if (params.ref) queryParams.ref = params.ref;

          const dirPath = params.path ?? "";
          const apiPath = dirPath
            ? `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/contents/${dirPath}`
            : `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/contents`;

          const data = await client.get(apiPath, queryParams);

          if (!Array.isArray(data)) {
            return {
              success: false,
              error: `Path "${dirPath}" is a file, not a directory. Use github_get_file to read a file.`,
            };
          }

          const entries = data.map((e) => ({
            name: e.name,
            path: e.path,
            type: e.type,
            size: e.size ?? 0,
            sha: e.sha,
            html_url: e.html_url,
          }));

          sdk.log.info(
            `github_list_directory: listed ${entries.length} entries at "${dirPath}" in ${params.owner}/${params.repo}`
          );

          return {
            success: true,
            data: {
              path: dirPath || "/",
              repo: `${params.owner}/${params.repo}`,
              ref: params.ref ?? null,
              entries,
              count: entries.length,
            },
          };
        } catch (err) {
          return { success: false, error: `Failed to list directory: ${formatError(err)}` };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_list_files
    // -------------------------------------------------------------------------
    {
      name: "github_list_files",
      description:
        "Use this when the user wants to list files in a GitHub repository or browse a directory. " +
        "Returns a list of files and subdirectories with their types and sizes. " +
        "Equivalent to github_list_directory.",
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
          path: {
            type: "string",
            description: "Directory path within the repo (default: repo root '')",
          },
          ref: {
            type: "string",
            description: "Branch, tag, or commit SHA to list from (default: repo default branch)",
          },
        },
        required: ["owner", "repo"],
      },
      execute: async (params, _context) => {
        try {
          const check = validateRequired(params, ["owner", "repo"]);
          if (!check.valid) return { success: false, error: check.error };

          const client = createGitHubClient(sdk);
          const queryParams = {};
          if (params.ref) queryParams.ref = params.ref;

          const dirPath = params.path ?? "";
          const apiPath = dirPath
            ? `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/contents/${dirPath}`
            : `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/contents`;

          const data = await client.get(apiPath, queryParams);

          if (!Array.isArray(data)) {
            return {
              success: false,
              error: `Path "${dirPath}" is a file, not a directory. Use github_get_file to read a file.`,
            };
          }

          const entries = data.map((e) => ({
            name: e.name,
            path: e.path,
            type: e.type,
            size: e.size ?? 0,
            sha: e.sha,
            html_url: e.html_url,
          }));

          sdk.log.info(
            `github_list_files: listed ${entries.length} entries at "${dirPath}" in ${params.owner}/${params.repo}`
          );

          return {
            success: true,
            data: {
              path: dirPath || "/",
              repo: `${params.owner}/${params.repo}`,
              ref: params.ref ?? null,
              entries,
              count: entries.length,
            },
          };
        } catch (err) {
          return { success: false, error: `Failed to list files: ${formatError(err)}` };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_search_code
    // -------------------------------------------------------------------------
    {
      name: "github_search_code",
      description:
        "Use this when the user wants to search for code patterns or text within a GitHub repository. " +
        "Returns matching files with line snippets. Uses GitHub's code search API.",
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
          query: {
            type: "string",
            description: "Search query (e.g. 'function authenticate' or 'class UserService')",
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
        required: ["owner", "repo", "query"],
      },
      execute: async (params, _context) => {
        try {
          const check = validateRequired(params, ["owner", "repo", "query"]);
          if (!check.valid) return { success: false, error: check.error };

          const client = createGitHubClient(sdk);

          // GitHub code search requires scoping to a repo
          const scopedQuery = `${params.query} repo:${params.owner}/${params.repo}`;

          const perPage = Math.min(Math.max(Math.floor(params.per_page ?? 30), 1), 100);
          const page = Math.max(Math.floor(params.page ?? 1), 1);

          const { data, pagination } = await client.getPaginated("/search/code", {
            q: scopedQuery,
            per_page: perPage,
            page,
          });

          const items = Array.isArray(data?.items) ? data.items : [];

          sdk.log.info(
            `github_search_code: found ${data?.total_count ?? 0} results for "${params.query}" in ${params.owner}/${params.repo}`
          );

          const results = items.map((item) => ({
            name: item.name,
            path: item.path,
            sha: item.sha,
            html_url: item.html_url,
            text_matches: item.text_matches?.map((m) => ({
              fragment: m.fragment,
              matches: m.matches?.map((match) => ({ text: match.text })) ?? [],
            })) ?? [],
          }));

          return {
            success: true,
            data: {
              query: params.query,
              repo: `${params.owner}/${params.repo}`,
              total_count: data?.total_count ?? 0,
              results,
              count: results.length,
              next_page: pagination.next ?? null,
            },
          };
        } catch (err) {
          return { success: false, error: `Failed to search code: ${formatError(err)}` };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_download_file
    // -------------------------------------------------------------------------
    {
      name: "github_download_file",
      description:
        "Use this when the user wants to download a file from a GitHub repository and get its content. " +
        "Returns the file content as text. Optionally saves to a local path under /tmp if save_to_file is provided.",
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
          path: {
            type: "string",
            description: "File path within the repo (e.g. 'src/index.js')",
          },
          ref: {
            type: "string",
            description: "Branch, tag, or commit SHA (default: repo default branch)",
          },
          save_to_file: {
            type: "string",
            description: "Optional absolute local file path under /tmp to save the content to (e.g. '/tmp/index.js'). Paths outside /tmp are rejected.",
          },
        },
        required: ["owner", "repo", "path"],
      },
      execute: async (params, _context) => {
        try {
          const check = validateRequired(params, ["owner", "repo", "path"]);
          if (!check.valid) return { success: false, error: check.error };

          const client = createGitHubClient(sdk);
          const queryParams = {};
          if (params.ref) queryParams.ref = params.ref;

          const data = await client.get(
            `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/contents/${params.path}`,
            queryParams
          );

          if (Array.isArray(data)) {
            return {
              success: false,
              error: `Path "${params.path}" is a directory, not a file. Use github_list_directory to browse it.`,
            };
          }

          const content = data.content ? decodeBase64(data.content) : null;

          sdk.log.info(
            `github_download_file: downloaded ${data.path} (${data.size} bytes) from ${params.owner}/${params.repo}`
          );

          const result = {
            success: true,
            data: {
              path: data.path,
              repo: `${params.owner}/${params.repo}`,
              size: data.size,
              sha: data.sha,
              content: content ?? null,
              html_url: data.html_url,
            },
          };

          if (params.save_to_file && content !== null) {
            const allowedRoot = "/tmp";
            const pathCheck = validateSavePath(params.save_to_file, allowedRoot);
            if (!pathCheck.valid) {
              result.data.save_error = pathCheck.error;
            } else {
              try {
                const { writeFile } = await import("node:fs/promises");
                await writeFile(pathCheck.resolved, content, "utf8");
                result.data.saved_to = pathCheck.resolved;
                sdk.log.info(`github_download_file: saved to ${pathCheck.resolved}`);
              } catch (writeErr) {
                result.data.save_error = `Could not save to file: ${formatError(writeErr)}`;
              }
            }
          }

          return result;
        } catch (err) {
          return { success: false, error: `Failed to download file: ${formatError(err)}` };
        }
      },
    },
  ];
}
