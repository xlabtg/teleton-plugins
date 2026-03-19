/**
 * github-dev-assistant — Full GitHub Development Workflow Automation
 *
 * Provides 14 tools for autonomous GitHub operations:
 *   Auth (1):      github_check_auth
 *   Repos (2):     github_list_repos, github_create_repo
 *   Files (3):     github_get_file, github_update_file, github_create_branch
 *   PRs (3):       github_create_pr, github_list_prs, github_merge_pr
 *   Issues (4):    github_create_issue, github_list_issues, github_comment_issue, github_close_issue
 *   Actions (1):   github_trigger_workflow
 *
 * Authentication:
 *   - Uses a Personal Access Token (PAT) stored in sdk.secrets as "github_token"
 *   - Set GITHUB_DEV_ASSISTANT_GITHUB_TOKEN env var or use the secrets store
 *
 * Security:
 *   - All tokens stored exclusively in sdk.secrets
 *   - No tokens, secrets, or sensitive data in sdk.log output
 *   - Destructive operations (merge) respect require_pr_review policy
 *
 * Usage:
 *   1. Set github_token in plugin secrets (Personal Access Token from github.com/settings/tokens)
 *   2. Call github_check_auth to verify authorization
 *   3. Use any of the remaining tools
 */

import { buildRepoOpsTools } from "./lib/repo-ops.js";
import { buildPRManagerTools } from "./lib/pr-manager.js";
import { buildIssueTrackerTools } from "./lib/issue-tracker.js";
import { createGitHubClient } from "./lib/github-client.js";
import { formatError } from "./lib/utils.js";

// ---------------------------------------------------------------------------
// Inline manifest — read by the Teleton runtime for SDK version gating,
// defaultConfig merging, and secrets registration.
// ---------------------------------------------------------------------------

export const manifest = {
  name: "github-dev-assistant",
  version: "1.0.0",
  sdkVersion: ">=1.0.0",
  description:
    "Full GitHub development workflow automation — repos, files, branches, PRs, issues, and GitHub Actions via Personal Access Token",
  secrets: {
    github_token: {
      required: true,
      env: "GITHUB_DEV_ASSISTANT_GITHUB_TOKEN",
      description: "GitHub Personal Access Token (create at https://github.com/settings/tokens)",
    },
  },
  defaultConfig: {
    default_owner: null,
    default_branch: "main",
    require_pr_review: false,
    commit_author_name: "Teleton AI Agent",
    commit_author_email: "agent@teleton.local",
  },
};

// ---------------------------------------------------------------------------
// SDK export — Teleton runtime calls tools(sdk) and uses the returned array
// ---------------------------------------------------------------------------

export const tools = (sdk) => {
  // ---------------------------------------------------------------------------
  // Auth tools (1)
  // ---------------------------------------------------------------------------

  const authTools = [
    // -------------------------------------------------------------------------
    // Tool: github_check_auth
    // -------------------------------------------------------------------------
    {
      name: "github_check_auth",
      description:
        "Use this when the user wants to check if GitHub is connected or verify the GitHub account. " +
        "Returns the authenticated GitHub username and confirms the token works.",
      category: "data-bearing",
      parameters: {
        type: "object",
        properties: {},
      },
      execute: async (_params, _context) => {
        try {
          const client = createGitHubClient(sdk);
          if (!client.isAuthenticated()) {
            return {
              success: true,
              data: {
                authenticated: false,
                message:
                  "GitHub is not connected. Please set the github_token secret with your Personal Access Token. " +
                  "You can create one at https://github.com/settings/tokens",
              },
            };
          }
          const user = await client.get("/user");
          sdk.log.info(`github_check_auth: authenticated as ${user.login}`);
          return {
            success: true,
            data: {
              authenticated: true,
              message: `GitHub is connected. Authenticated as @${user.login} (${user.name ?? user.login}).`,
              login: user.login,
              name: user.name ?? null,
            },
          };
        } catch (err) {
          if (err.status === 401) {
            return {
              success: true,
              data: {
                authenticated: false,
                message:
                  "GitHub token is invalid or expired. Please update the github_token secret with a valid Personal Access Token.",
              },
            };
          }
          return { success: false, error: `GitHub auth check failed: ${formatError(err)}` };
        }
      },
    },
  ];

  // ---------------------------------------------------------------------------
  // Repository, file, and branch tools (5)
  // ---------------------------------------------------------------------------
  const repoTools = buildRepoOpsTools(sdk);

  // ---------------------------------------------------------------------------
  // Pull request tools (3)
  // ---------------------------------------------------------------------------
  const prTools = buildPRManagerTools(sdk);

  // ---------------------------------------------------------------------------
  // Issue and workflow tools (5)
  // ---------------------------------------------------------------------------
  const issueTools = buildIssueTrackerTools(sdk);

  // ---------------------------------------------------------------------------
  // Combine and return all 14 tools
  // ---------------------------------------------------------------------------
  return [
    ...authTools,   // 1: github_check_auth
    ...repoTools,   // 5: github_list_repos, github_create_repo, github_get_file, github_update_file, github_create_branch
    ...prTools,     // 3: github_create_pr, github_list_prs, github_merge_pr
    ...issueTools,  // 5: github_create_issue, github_list_issues, github_comment_issue, github_close_issue, github_trigger_workflow
  ];
};
