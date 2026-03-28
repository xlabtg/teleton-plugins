/**
 * github-dev-assistant — Full GitHub Development Workflow Automation
 *
 * Provides 60 tools covering:
 *   Auth (1):          github_check_auth
 *   Repos (10):        github_list_repos, github_create_repo, github_fork_repo,
 *                      github_search_repos, github_list_branches, github_push_files,
 *                      github_get_repo_tree, github_list_tags, github_list_releases,
 *                      github_get_latest_release
 *   Files (8):         github_get_file, github_update_file, github_create_branch,
 *                      github_delete_file, github_list_directory, github_list_files,
 *                      github_search_code, github_download_file
 *   PRs (9):           github_create_pr, github_list_prs, github_get_pull_request,
 *                      github_merge_pr, github_list_comments, github_list_pull_request_reviews,
 *                      github_search_issues, github_update_pr, github_add_pr_review
 *   Issues (8):        github_create_issue, github_list_issues, github_comment_issue,
 *                      github_close_issue, github_update_issue, github_reopen_issue,
 *                      github_assign_issue
 *   Commits (2):       github_list_commits, github_get_commit
 *   Actions (5):       github_trigger_workflow, github_list_workflows,
 *                      github_list_workflow_runs, github_cancel_workflow_run,
 *                      github_get_job_logs
 *   Labels (3):        github_list_labels, github_create_label, github_delete_label
 *   Repo Info (3):     github_list_languages, github_list_collaborators, github_list_teams
 *   User/Social (8):   github_get_me, github_search_users, github_list_notifications,
 *                      github_star_repo, github_unstar_repo, github_list_gists,
 *                      github_get_gist, github_create_gist
 *   Security (2):      github_list_code_scanning_alerts, github_list_dependabot_alerts
 *   Discussions (2):   github_list_discussions, github_get_discussion
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
import { buildFileOpsTools } from "./lib/file-ops.js";
import { buildCommitOpsTools } from "./lib/commit-ops.js";
import { buildIssuePROpsTools } from "./lib/issue-pr-ops.js";
import { buildRepoInfoOpsTools } from "./lib/repo-info-ops.js";
import { buildWorkflowOpsTools } from "./lib/workflow-ops.js";
import { buildLabelOpsTools } from "./lib/label-ops.js";
import { buildExtendedRepoOpsTools } from "./lib/extended-repo-ops.js";
import { buildExtendedPROpsTools } from "./lib/extended-pr-ops.js";
import { buildUserSocialOpsTools } from "./lib/user-social-ops.js";
import { buildSecurityDiscussionOpsTools } from "./lib/security-discussion-ops.js";
import { createGitHubClient } from "./lib/github-client.js";
import { formatError } from "./lib/utils.js";

// ---------------------------------------------------------------------------
// Inline manifest — read by the Teleton runtime for SDK version gating,
// defaultConfig merging, and secrets registration.
// ---------------------------------------------------------------------------

export const manifest = {
  name: "github-dev-assistant",
  version: "3.1.2",
  sdkVersion: ">=1.0.0",
  description:
    "Complete GitHub development workflow automation — repos, files, branches, PRs, issues, commits, Actions workflows, labels, repo info, user profile, gists, notifications, starring, security alerts, and discussions via Personal Access Token",
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
  // Pull request tools (4)
  // ---------------------------------------------------------------------------
  const prTools = buildPRManagerTools(sdk);

  // ---------------------------------------------------------------------------
  // Issue and workflow tools (5)
  // ---------------------------------------------------------------------------
  const issueTools = buildIssueTrackerTools(sdk);

  // ---------------------------------------------------------------------------
  // Extended file operations (5): delete, list directory, list files, search code, download
  // ---------------------------------------------------------------------------
  const fileOpsTools = buildFileOpsTools(sdk);

  // ---------------------------------------------------------------------------
  // Commit operations (2): list commits, get commit
  // ---------------------------------------------------------------------------
  const commitOpsTools = buildCommitOpsTools(sdk);

  // ---------------------------------------------------------------------------
  // Extended issue/PR operations (5): list comments, update issue, reopen issue,
  // assign issue, list PR reviews
  // ---------------------------------------------------------------------------
  const issuePROpsTools = buildIssuePROpsTools(sdk);

  // ---------------------------------------------------------------------------
  // Repository information tools (3): languages, collaborators, teams
  // ---------------------------------------------------------------------------
  const repoInfoOpsTools = buildRepoInfoOpsTools(sdk);

  // ---------------------------------------------------------------------------
  // Extended workflow operations (3): list workflows, list runs, cancel run
  // ---------------------------------------------------------------------------
  const workflowOpsTools = buildWorkflowOpsTools(sdk);

  // ---------------------------------------------------------------------------
  // Label operations (3): list labels, create label, delete label
  // ---------------------------------------------------------------------------
  const labelOpsTools = buildLabelOpsTools(sdk);

  // ---------------------------------------------------------------------------
  // Extended repo operations (8): fork, search repos, list branches, push files,
  // repo tree, list tags, list releases, get latest release
  // ---------------------------------------------------------------------------
  const extendedRepoOpsTools = buildExtendedRepoOpsTools(sdk);

  // ---------------------------------------------------------------------------
  // Extended PR operations (4): search issues, update PR, add PR review, get job logs
  // ---------------------------------------------------------------------------
  const extendedPROpsTools = buildExtendedPROpsTools(sdk);

  // ---------------------------------------------------------------------------
  // User/social operations (8): get_me, search users, notifications,
  // star/unstar, list/get/create gists
  // ---------------------------------------------------------------------------
  const userSocialOpsTools = buildUserSocialOpsTools(sdk);

  // ---------------------------------------------------------------------------
  // Security & discussion operations (4): code scanning, dependabot,
  // list/get discussions
  // ---------------------------------------------------------------------------
  const securityDiscussionOpsTools = buildSecurityDiscussionOpsTools(sdk);

  // ---------------------------------------------------------------------------
  // Combine and return all tools
  // ---------------------------------------------------------------------------
  return [
    ...authTools,                  //  1: github_check_auth
    ...repoTools,                  //  5: github_list_repos, github_create_repo, github_get_file, github_update_file, github_create_branch
    ...prTools,                    //  4: github_create_pr, github_list_prs, github_get_pull_request, github_merge_pr
    ...issueTools,                 //  5: github_create_issue, github_list_issues, github_comment_issue, github_close_issue, github_trigger_workflow
    ...fileOpsTools,               //  5: github_delete_file, github_list_directory, github_list_files, github_search_code, github_download_file
    ...commitOpsTools,             //  2: github_list_commits, github_get_commit
    ...issuePROpsTools,            //  5: github_list_comments, github_update_issue, github_reopen_issue, github_assign_issue, github_list_pull_request_reviews
    ...repoInfoOpsTools,           //  3: github_list_languages, github_list_collaborators, github_list_teams
    ...workflowOpsTools,           //  3: github_list_workflows, github_list_workflow_runs, github_cancel_workflow_run
    ...labelOpsTools,              //  3: github_list_labels, github_create_label, github_delete_label
    ...extendedRepoOpsTools,       //  8: github_fork_repo, github_search_repos, github_list_branches, github_push_files, github_get_repo_tree, github_list_tags, github_list_releases, github_get_latest_release
    ...extendedPROpsTools,         //  4: github_search_issues, github_update_pr, github_add_pr_review, github_get_job_logs
    ...userSocialOpsTools,         //  8: github_get_me, github_search_users, github_list_notifications, github_star_repo, github_unstar_repo, github_list_gists, github_get_gist, github_create_gist
    ...securityDiscussionOpsTools, //  4: github_list_code_scanning_alerts, github_list_dependabot_alerts, github_list_discussions, github_get_discussion
  ];
};
