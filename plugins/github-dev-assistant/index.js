/**
 * github-dev-assistant — Full GitHub Development Workflow Automation
 *
 * Provides 15 tools for autonomous GitHub operations:
 *   Auth (2):      github_auth, github_check_auth
 *   Repos (2):     github_list_repos, github_create_repo
 *   Files (3):     github_get_file, github_update_file, github_create_branch
 *   PRs (3):       github_create_pr, github_list_prs, github_merge_pr
 *   Issues (4):    github_create_issue, github_list_issues, github_comment_issue, github_close_issue
 *   Actions (1):   github_trigger_workflow
 *
 * Security:
 *   - All tokens stored exclusively in sdk.secrets
 *   - OAuth CSRF protection via state parameter with 10-minute TTL
 *   - No tokens, secrets, or sensitive data in sdk.log output
 *   - Destructive operations (merge) respect require_pr_review policy
 *
 * Usage:
 *   1. Set github_client_id and github_client_secret in plugin secrets
 *   2. Call github_auth to get an authorization URL
 *   3. Open URL in browser, authorize, get the code from the callback
 *   4. (The web-ui oauth-callback.html handles this automatically)
 *   5. Call github_check_auth to verify authorization
 *   6. Use any of the 13 remaining tools
 */

import { createGitHubClient } from "./lib/github-client.js";
import { createAuthManager } from "./lib/auth.js";
import { buildRepoOpsTools } from "./lib/repo-ops.js";
import { buildPRManagerTools } from "./lib/pr-manager.js";
import { buildIssueTrackerTools } from "./lib/issue-tracker.js";
import { formatError } from "./lib/utils.js";

// ---------------------------------------------------------------------------
// SDK export — Teleton runtime calls tools(sdk) and uses the returned array
// ---------------------------------------------------------------------------

export const tools = (sdk) => {
  // Create shared infrastructure
  const client = createGitHubClient(sdk);
  const auth = createAuthManager(sdk);

  // ---------------------------------------------------------------------------
  // Auth tools (2)
  // ---------------------------------------------------------------------------

  const authTools = [
    // -------------------------------------------------------------------------
    // Tool: github_auth
    // -------------------------------------------------------------------------
    {
      name: "github_auth",
      description:
        "Initiate OAuth authorization with GitHub. Returns an authorization URL to open in the browser. " +
        "After authorizing, the user receives a code and state from the callback page — " +
        "pass both back to complete the flow (the web-ui oauth-callback.html handles this automatically).",
      category: "action",
      parameters: {
        type: "object",
        properties: {
          scopes: {
            type: "array",
            items: { type: "string" },
            description:
              "OAuth scopes to request (default: ['repo', 'workflow', 'user']). " +
              "Common scopes: repo, read:repo, workflow, user, read:user, gist.",
          },
          code: {
            type: "string",
            description:
              "Authorization code from the GitHub callback. " +
              "Provide this (along with state) to complete the OAuth flow.",
          },
          state: {
            type: "string",
            description:
              "CSRF state token from the GitHub callback. " +
              "Must match the state returned when the auth URL was generated.",
          },
        },
      },
      execute: async (params) => {
        try {
          // Phase 2: code + state provided — exchange for access token
          if (params.code && params.state) {
            const result = await auth.exchangeCode(params.code, params.state);
            sdk.log.info("github_auth: OAuth flow completed successfully");
            return {
              success: true,
              data: {
                authenticated: true,
                user_login: result.user_login,
                scopes: result.scopes,
                message:
                  `Successfully authenticated as ${result.user_login}. ` +
                  `Granted scopes: ${result.scopes.join(", ") || "none listed"}.`,
              },
            };
          }

          // Phase 1: generate auth URL
          const scopes = Array.isArray(params.scopes)
            ? params.scopes
            : ["repo", "workflow", "user"];

          const { auth_url, state, instructions } = auth.initiateOAuth(scopes);

          return {
            success: true,
            data: {
              auth_url,
              state,
              instructions,
              scopes_requested: scopes,
            },
          };
        } catch (err) {
          return { success: false, error: formatError(err) };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Tool: github_check_auth
    // -------------------------------------------------------------------------
    {
      name: "github_check_auth",
      description:
        "Check the current GitHub authorization status. " +
        "Returns whether the plugin is authenticated and the authenticated user's login if so.",
      category: "data-bearing",
      parameters: {
        type: "object",
        properties: {},
      },
      execute: async () => {
        try {
          const result = await auth.checkAuth(client);
          return {
            success: true,
            data: result,
          };
        } catch (err) {
          return { success: false, error: formatError(err) };
        }
      },
    },
  ];

  // ---------------------------------------------------------------------------
  // Repository, file, and branch tools (5)
  // ---------------------------------------------------------------------------
  const repoTools = buildRepoOpsTools(client, sdk);

  // ---------------------------------------------------------------------------
  // Pull request tools (3)
  // ---------------------------------------------------------------------------
  const prTools = buildPRManagerTools(client, sdk);

  // ---------------------------------------------------------------------------
  // Issue and workflow tools (5)
  // ---------------------------------------------------------------------------
  const issueTools = buildIssueTrackerTools(client, sdk);

  // ---------------------------------------------------------------------------
  // Combine and return all 15 tools
  // ---------------------------------------------------------------------------
  return [
    ...authTools,   // 2: github_auth, github_check_auth
    ...repoTools,   // 5: github_list_repos, github_create_repo, github_get_file, github_update_file, github_create_branch
    ...prTools,     // 3: github_create_pr, github_list_prs, github_merge_pr
    ...issueTools,  // 5: github_create_issue, github_list_issues, github_comment_issue, github_close_issue, github_trigger_workflow
  ];
};
