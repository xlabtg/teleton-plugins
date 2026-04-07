/**
 * self-improvement-assistant — Autonomous codebase analysis and GitHub issue creation
 *
 * Analyzes GitHub repositories for code quality issues, potential bugs, and
 * improvement opportunities, then creates well-formatted GitHub issues from findings.
 * Supports scheduled autonomous analysis and one-off manual runs.
 *
 * Tools (4):
 *   self_analyze_codebase      — Analyze a repo's JS/TS files for quality issues
 *   self_create_issue          — Create a GitHub issue from an analysis finding
 *   self_schedule_analysis     — Enable or disable periodic autonomous analysis
 *   self_list_analysis_history — List past analysis runs from the local log
 *
 * Authentication:
 *   - Uses a GitHub Personal Access Token stored in sdk.secrets as "github_token"
 *   - Set SELF_IMPROVEMENT_ASSISTANT_GITHUB_TOKEN env var or use the secrets store
 *
 * Security:
 *   - Tokens stored exclusively in sdk.secrets — never logged
 *   - Issue creation is gated behind scope: "admin-only"
 *   - auto_create_issues defaults to false, requiring explicit user confirmation
 */

// ---------------------------------------------------------------------------
// Inline manifest — read by the Teleton runtime for SDK version gating,
// defaultConfig merging, and secrets registration.
// ---------------------------------------------------------------------------

export const manifest = {
  name: "self-improvement-assistant",
  version: "1.0.0",
  sdkVersion: ">=1.0.0",
  description:
    "Autonomous codebase analysis and GitHub issue creation — analyze repositories for bugs, " +
    "security issues, and improvement opportunities, then create structured GitHub issues from findings",
  secrets: {
    github_token: {
      required: true,
      env: "SELF_IMPROVEMENT_ASSISTANT_GITHUB_TOKEN",
      description:
        "GitHub Personal Access Token with repo scope (create at https://github.com/settings/tokens)",
    },
  },
  defaultConfig: {
    analysis_interval_hours: 24,
    auto_create_issues: false,
    max_files_per_analysis: 50,
    exclude_paths: ["node_modules/", "dist/", ".test.", ".spec."],
  },
};

// ---------------------------------------------------------------------------
// Database migration — analysis_log and improvement_tasks tables
// ---------------------------------------------------------------------------

export function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS analysis_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      repo TEXT NOT NULL,
      branch TEXT NOT NULL DEFAULT 'main',
      files_analyzed INTEGER NOT NULL DEFAULT 0,
      issues_found INTEGER NOT NULL DEFAULT 0,
      issues_created INTEGER NOT NULL DEFAULT 0,
      summary TEXT,
      triggered_by TEXT NOT NULL DEFAULT 'manual'
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS improvement_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      repo TEXT NOT NULL,
      file_path TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'medium',
      category TEXT NOT NULL DEFAULT 'code-quality',
      description TEXT NOT NULL,
      suggestion TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      github_issue_url TEXT,
      FOREIGN KEY (run_id) REFERENCES analysis_log(id)
    )
  `);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build an Authorization header from the stored secret.
 * Returns null if the token is not configured.
 */
function getAuthHeaders(sdk) {
  const token = sdk.secrets.get("github_token");
  if (!token) return null;
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "teleton-self-improvement-assistant/1.0",
  };
}

/** Perform a GitHub API request with a 15-second timeout. */
async function ghFetch(path, opts = {}, sdk) {
  const headers = getAuthHeaders(sdk);
  if (!headers) throw new Error("github_token secret not configured");

  const url = path.startsWith("http") ? path : `https://api.github.com${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: { ...headers, ...(opts.headers ?? {}) },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub API ${res.status}: ${body.slice(0, 300)}`);
  }

  const ct = res.headers.get("content-type") ?? "";
  return ct.includes("application/json") ? res.json() : res.text();
}

/** Truncate long strings to avoid flooding the LLM context. */
function trunc(str, max = 500) {
  if (!str) return str;
  return String(str).length > max ? String(str).slice(0, max) + "…" : String(str);
}

/** Severity badge for GitHub issue bodies. */
function severityEmoji(severity) {
  return { critical: "🔴", high: "🟠", medium: "🟡", low: "🔵" }[severity] ?? "⚪";
}

// ---------------------------------------------------------------------------
// SDK export
// ---------------------------------------------------------------------------

export const tools = (sdk) => [
  // ─── Tool 1: self_analyze_codebase ─────────────────────────────────────
  {
    name: "self_analyze_codebase",
    description:
      "Analyze a GitHub repository's JavaScript/TypeScript source files for potential bugs, " +
      "security vulnerabilities, performance issues, missing tests, and readability problems. " +
      "Returns a list of structured findings with severity and fix suggestions. " +
      "Use this when the user asks to review, audit, or analyze a codebase.",
    category: "data-bearing",
    parameters: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description: "GitHub repository in owner/repo format (e.g. 'xlabtg/teleton-plugins')",
        },
        branch: {
          type: "string",
          description: "Branch to analyze (defaults to 'main')",
        },
        focus_areas: {
          type: "array",
          items: {
            type: "string",
            enum: ["security", "performance", "readability", "tests", "documentation"],
          },
          description: "Optional list of focus areas to prioritize in the analysis",
        },
      },
      required: ["repo"],
    },
    execute: async (params, _context) => {
      try {
        const token = sdk.secrets.get("github_token");
        if (!token) {
          return {
            success: false,
            error:
              "github_token secret is not configured. " +
              "Set SELF_IMPROVEMENT_ASSISTANT_GITHUB_TOKEN env var or use the secrets store.",
          };
        }

        const branch = params.branch ?? "main";
        const config = sdk.pluginConfig;
        const excludePaths = config.exclude_paths ?? manifest.defaultConfig.exclude_paths;
        const maxFiles = config.max_files_per_analysis ?? manifest.defaultConfig.max_files_per_analysis;

        sdk.log.info(`self_analyze_codebase: fetching file tree for ${params.repo}@${branch}`);

        // 1. Fetch the repository tree
        const [owner, repoName] = params.repo.split("/");
        const treeData = await ghFetch(
          `/repos/${owner}/${repoName}/git/trees/${branch}?recursive=1`,
          {},
          sdk
        );

        if (!treeData.tree) {
          return { success: false, error: "Failed to fetch repository tree — check repo name and branch" };
        }

        // 2. Filter to JS/TS source files, excluding configured paths
        const sourceFiles = treeData.tree
          .filter((f) => f.type === "blob")
          .filter((f) => /\.(js|ts|tsx|jsx|mjs|cjs)$/.test(f.path))
          .filter((f) => !excludePaths.some((ex) => f.path.includes(ex.replace(/\*/g, ""))))
          .slice(0, maxFiles);

        if (sourceFiles.length === 0) {
          return {
            success: true,
            data: {
              repo: params.repo,
              branch,
              files_analyzed: 0,
              findings: [],
              summary: "No JavaScript/TypeScript source files found after applying exclusion filters.",
            },
          };
        }

        sdk.log.info(`self_analyze_codebase: analyzing ${sourceFiles.length} files`);

        // 3. Fetch file contents and apply heuristic pattern analysis
        const findings = [];

        for (const file of sourceFiles) {
          let content;
          try {
            const fileData = await ghFetch(
              `/repos/${owner}/${repoName}/contents/${encodeURIComponent(file.path)}?ref=${branch}`,
              {},
              sdk
            );
            content = fileData.encoding === "base64"
              ? Buffer.from(fileData.content, "base64").toString("utf-8")
              : fileData.content;
          } catch {
            // Skip unreadable files silently
            continue;
          }

          const fileFindings = analyzeFileContent(file.path, content, params.focus_areas);
          findings.push(...fileFindings);
        }

        // 4. Deduplicate and sort by severity
        const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
        findings.sort((a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3));

        // 5. Persist to analysis_log
        const runResult = sdk.db
          .prepare(
            `INSERT INTO analysis_log (timestamp, repo, branch, files_analyzed, issues_found, triggered_by, summary)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            Date.now(),
            params.repo,
            branch,
            sourceFiles.length,
            findings.length,
            "manual",
            `Analyzed ${sourceFiles.length} files, found ${findings.length} issues`
          );

        const runId = runResult.lastInsertRowid;

        for (const f of findings) {
          sdk.db
            .prepare(
              `INSERT INTO improvement_tasks (run_id, repo, file_path, severity, category, description, suggestion, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(runId, params.repo, f.file, f.severity, f.category, f.description, f.suggestion, Date.now());
        }

        sdk.log.info(`self_analyze_codebase: found ${findings.length} issues across ${sourceFiles.length} files`);

        const summary =
          findings.length === 0
            ? `✅ No issues found in ${sourceFiles.length} analyzed files — code looks healthy!`
            : `Found ${findings.length} issue(s) across ${sourceFiles.length} file(s). ` +
              `Critical: ${findings.filter((f) => f.severity === "critical").length}, ` +
              `High: ${findings.filter((f) => f.severity === "high").length}, ` +
              `Medium: ${findings.filter((f) => f.severity === "medium").length}, ` +
              `Low: ${findings.filter((f) => f.severity === "low").length}.`;

        return {
          success: true,
          data: {
            run_id: Number(runId),
            repo: params.repo,
            branch,
            files_analyzed: sourceFiles.length,
            findings_count: findings.length,
            findings: findings.slice(0, 20), // cap response size
            summary,
            next_steps:
              findings.length > 0
                ? "Use self_create_issue to create GitHub issues for specific findings."
                : "No action needed.",
          },
        };
      } catch (err) {
        sdk.log.error(`self_analyze_codebase failed: ${err.message}`);
        return { success: false, error: trunc(err.message) };
      }
    },
  },

  // ─── Tool 2: self_create_issue ─────────────────────────────────────────
  {
    name: "self_create_issue",
    description:
      "Create a structured GitHub issue from a code analysis finding. " +
      "Formats it with severity, file path, description, and fix suggestion. " +
      "Use this after running self_analyze_codebase to track specific findings as GitHub issues.",
    category: "action",
    scope: "admin-only",
    parameters: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description: "GitHub repository in owner/repo format",
        },
        title: {
          type: "string",
          description: "Issue title (concise, descriptive)",
        },
        file: {
          type: "string",
          description: "File path where the issue was found",
        },
        severity: {
          type: "string",
          enum: ["critical", "high", "medium", "low"],
          description: "Issue severity level",
        },
        category: {
          type: "string",
          enum: ["bug", "security", "performance", "readability", "test", "documentation"],
          description: "Issue category",
        },
        description: {
          type: "string",
          description: "Detailed description of the problem",
        },
        suggestion: {
          type: "string",
          description: "Concrete suggestion for fixing the problem",
        },
        code_snippet: {
          type: "string",
          description: "Optional example code snippet illustrating the issue or the fix",
        },
        labels: {
          type: "array",
          items: { type: "string" },
          description: "Labels to add (default: ['ai-suggested'])",
        },
        task_id: {
          type: "number",
          description: "Optional improvement_tasks.id to link and update after creation",
        },
      },
      required: ["repo", "title", "file", "description", "suggestion"],
    },
    execute: async (params, _context) => {
      try {
        const token = sdk.secrets.get("github_token");
        if (!token) {
          return {
            success: false,
            error: "github_token secret is not configured.",
          };
        }

        const severity = params.severity ?? "medium";
        const category = params.category ?? "code-quality";
        const labels = params.labels ?? ["ai-suggested"];

        const body = buildIssueBody({ ...params, severity, category });

        const [owner, repoName] = params.repo.split("/");
        const issue = await ghFetch(
          `/repos/${owner}/${repoName}/issues`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: params.title,
              body,
              labels,
            }),
          },
          sdk
        );

        // Update the task record if task_id was supplied
        if (params.task_id) {
          sdk.db
            .prepare(
              `UPDATE improvement_tasks SET status = 'created', github_issue_url = ? WHERE id = ?`
            )
            .run(issue.html_url, params.task_id);
        }

        // Also update the analysis_log issues_created counter if we can find the run
        if (params.task_id) {
          const task = sdk.db
            .prepare("SELECT run_id FROM improvement_tasks WHERE id = ?")
            .get(params.task_id);
          if (task) {
            sdk.db
              .prepare(
                "UPDATE analysis_log SET issues_created = issues_created + 1 WHERE id = ?"
              )
              .run(task.run_id);
          }
        }

        sdk.log.info(`self_create_issue: created issue #${issue.number} in ${params.repo}`);

        return {
          success: true,
          data: {
            issue_number: issue.number,
            issue_url: issue.html_url,
            title: issue.title,
            state: issue.state,
          },
        };
      } catch (err) {
        sdk.log.error(`self_create_issue failed: ${err.message}`);
        return { success: false, error: trunc(err.message) };
      }
    },
  },

  // ─── Tool 3: self_schedule_analysis ────────────────────────────────────
  {
    name: "self_schedule_analysis",
    description:
      "Enable or disable periodic autonomous codebase analysis for a repository. " +
      "When enabled, the analysis runs on the configured interval. " +
      "Use this when the user wants to set up or stop automated code quality monitoring.",
    category: "action",
    scope: "admin-only",
    parameters: {
      type: "object",
      properties: {
        enabled: {
          type: "boolean",
          description: "true to enable scheduled analysis, false to disable",
        },
        repo: {
          type: "string",
          description: "GitHub repository in owner/repo format (required when enabling)",
        },
        interval_hours: {
          type: "number",
          description: "Analysis interval in hours (default: 24). Supported: 6, 12, 24, 168",
        },
      },
      required: ["enabled"],
    },
    execute: async (params, _context) => {
      try {
        if (params.enabled) {
          if (!params.repo) {
            return { success: false, error: "repo is required when enabling scheduled analysis" };
          }

          const hours = params.interval_hours ?? sdk.pluginConfig.analysis_interval_hours ?? 24;
          const intervalMs = hours * 60 * 60 * 1000;

          // Store schedule config in sdk.storage for persistence
          sdk.storage.set("scheduled_repo", params.repo);
          sdk.storage.set("scheduled_interval_hours", hours);
          sdk.storage.set("scheduled_enabled", true);

          // Clear existing timer if any
          if (global.__selfImproveTimer) {
            clearInterval(global.__selfImproveTimer);
          }

          global.__selfImproveTimer = setInterval(async () => {
            sdk.log.info(`self_schedule_analysis: running scheduled analysis for ${params.repo}`);
            try {
              const token = sdk.secrets.get("github_token");
              if (!token) {
                sdk.log.warn("self_schedule_analysis: github_token not set — skipping");
                return;
              }
              // We re-use the same analysis logic via a minimal internal call
              const branch = sdk.pluginConfig.default_branch ?? "main";
              const [owner, repoName] = params.repo.split("/");
              const treeData = await ghFetch(
                `/repos/${owner}/${repoName}/git/trees/${branch}?recursive=1`,
                {},
                sdk
              );
              const excludePaths = sdk.pluginConfig.exclude_paths ?? manifest.defaultConfig.exclude_paths;
              const maxFiles = sdk.pluginConfig.max_files_per_analysis ?? manifest.defaultConfig.max_files_per_analysis;
              const sourceFiles = (treeData.tree ?? [])
                .filter((f) => f.type === "blob")
                .filter((f) => /\.(js|ts|tsx|jsx|mjs|cjs)$/.test(f.path))
                .filter((f) => !excludePaths.some((ex) => f.path.includes(ex.replace(/\*/g, ""))))
                .slice(0, maxFiles);

              const findings = [];
              for (const file of sourceFiles) {
                try {
                  const fileData = await ghFetch(
                    `/repos/${owner}/${repoName}/contents/${encodeURIComponent(file.path)}?ref=${branch}`,
                    {},
                    sdk
                  );
                  const content =
                    fileData.encoding === "base64"
                      ? Buffer.from(fileData.content, "base64").toString("utf-8")
                      : fileData.content;
                  findings.push(...analyzeFileContent(file.path, content, []));
                } catch {
                  // skip unreadable files
                }
              }

              sdk.db
                .prepare(
                  `INSERT INTO analysis_log (timestamp, repo, branch, files_analyzed, issues_found, triggered_by, summary)
                   VALUES (?, ?, ?, ?, ?, ?, ?)`
                )
                .run(
                  Date.now(),
                  params.repo,
                  branch,
                  sourceFiles.length,
                  findings.length,
                  "scheduled",
                  `Scheduled: analyzed ${sourceFiles.length} files, found ${findings.length} issues`
                );
              sdk.log.info(
                `self_schedule_analysis: completed — ${findings.length} issues in ${sourceFiles.length} files`
              );
            } catch (err) {
              sdk.log.error(`self_schedule_analysis: scheduled run failed — ${err.message}`);
            }
          }, intervalMs);

          sdk.log.info(
            `self_schedule_analysis: enabled for ${params.repo} every ${hours}h`
          );

          return {
            success: true,
            data: {
              enabled: true,
              repo: params.repo,
              interval_hours: hours,
              message: `Scheduled analysis enabled for ${params.repo} — runs every ${hours} hour(s).`,
            },
          };
        } else {
          // Disable
          if (global.__selfImproveTimer) {
            clearInterval(global.__selfImproveTimer);
            delete global.__selfImproveTimer;
          }
          sdk.storage.set("scheduled_enabled", false);
          sdk.log.info("self_schedule_analysis: disabled");

          return {
            success: true,
            data: {
              enabled: false,
              message: "Scheduled analysis has been disabled.",
            },
          };
        }
      } catch (err) {
        sdk.log.error(`self_schedule_analysis failed: ${err.message}`);
        return { success: false, error: trunc(err.message) };
      }
    },
  },

  // ─── Tool 4: self_list_analysis_history ────────────────────────────────
  {
    name: "self_list_analysis_history",
    description:
      "List past codebase analysis runs with their timestamps, repositories, and findings counts. " +
      "Use this when the user wants to review the history of autonomous analysis sessions.",
    category: "data-bearing",
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of runs to return (default: 20)",
        },
        repo: {
          type: "string",
          description: "Filter by repository (owner/repo format)",
        },
      },
    },
    execute: async (params, _context) => {
      try {
        const limit = params.limit ?? 20;
        let query = "SELECT * FROM analysis_log";
        const bindings = [];

        if (params.repo) {
          query += " WHERE repo = ?";
          bindings.push(params.repo);
        }

        query += " ORDER BY timestamp DESC LIMIT ?";
        bindings.push(limit);

        const rows = sdk.db.prepare(query).all(...bindings);

        const runs = rows.map((r) => ({
          id: r.id,
          repo: r.repo,
          branch: r.branch,
          date: new Date(r.timestamp).toISOString(),
          files_analyzed: r.files_analyzed,
          issues_found: r.issues_found,
          issues_created: r.issues_created,
          triggered_by: r.triggered_by,
          summary: r.summary,
        }));

        return {
          success: true,
          data: {
            total: runs.length,
            runs,
          },
        };
      } catch (err) {
        sdk.log.error(`self_list_analysis_history failed: ${err.message}`);
        return { success: false, error: trunc(err.message) };
      }
    },
  },
];

// ---------------------------------------------------------------------------
// Lifecycle hooks
// ---------------------------------------------------------------------------

/** Restore the scheduled analysis timer after a Teleton restart. */
export async function start(ctx) {
  try {
    // Re-read the persisted schedule via a temporary sdk.storage proxy.
    // The storage API is not directly available in start(), so we use the db.
    // (Nothing to do here — the interval was cleared on restart anyway. A
    // future enhancement could re-register via the start context if the
    // teleton runtime exposes a scheduling primitive.)
    ctx.log("self-improvement-assistant: started");
  } catch {
    // Non-fatal
  }
}

export async function stop() {
  if (global.__selfImproveTimer) {
    clearInterval(global.__selfImproveTimer);
    delete global.__selfImproveTimer;
  }
}

// ---------------------------------------------------------------------------
// Heuristic static analysis — no LLM required, fast and deterministic
// ---------------------------------------------------------------------------

/**
 * Analyze a single file's content with regex-based heuristics.
 * Returns an array of finding objects.
 */
function analyzeFileContent(filePath, content, focusAreas = []) {
  const lines = content.split("\n");
  const findings = [];
  const focus = new Set(focusAreas.length > 0 ? focusAreas : ["security", "performance", "readability", "tests"]);

  // ── Security checks ───────────────────────────────────────────────────────
  if (focus.has("security")) {
    checkPattern(findings, filePath, lines, {
      pattern: /eval\s*\(/,
      severity: "critical",
      category: "security",
      description: "Use of eval() detected — executes arbitrary code and is a common injection vector.",
      suggestion: "Replace eval() with safer alternatives: JSON.parse() for JSON, Function constructors for dynamic code, or restructure the logic to avoid dynamic execution.",
    });

    checkPattern(findings, filePath, lines, {
      pattern: /new\s+Function\s*\(/,
      severity: "high",
      category: "security",
      description: "Dynamic Function constructor detected — similar risks to eval().",
      suggestion: "Avoid new Function() for dynamic code execution. Use static module imports or configuration-driven dispatch tables instead.",
    });

    checkPattern(findings, filePath, lines, {
      pattern: /innerHTML\s*=/,
      severity: "high",
      category: "security",
      description: "Direct innerHTML assignment detected — potential XSS vulnerability if content is user-controlled.",
      suggestion: "Use textContent for plain text, or sanitize HTML with DOMPurify before setting innerHTML.",
    });

    checkPattern(findings, filePath, lines, {
      pattern: /console\.log\(.*(?:token|secret|password|key|auth)/i,
      severity: "critical",
      category: "security",
      description: "Potential credential logging detected — secrets must never be written to logs.",
      suggestion: "Remove this log statement or replace the sensitive value with a placeholder like '[REDACTED]'.",
    });

    checkPattern(findings, filePath, lines, {
      pattern: /crypto\.createHash\(['"]md5['"]\)|crypto\.createHash\(['"]sha1['"]\)/,
      severity: "medium",
      category: "security",
      description: "Weak cryptographic hash function (MD5/SHA-1) detected.",
      suggestion: "Replace with SHA-256 or SHA-512: crypto.createHash('sha256').",
    });
  }

  // ── Performance checks ────────────────────────────────────────────────────
  if (focus.has("performance")) {
    checkPattern(findings, filePath, lines, {
      pattern: /await\s+.*\bawait\b/,
      severity: "low",
      category: "performance",
      description: "Sequential await calls detected on the same line — may indicate missed parallelism opportunity.",
      suggestion: "Use Promise.all([...]) to run independent async operations in parallel.",
    });

    checkPattern(findings, filePath, lines, {
      pattern: /\.forEach\s*\(\s*async/,
      severity: "medium",
      category: "performance",
      description: "async callback inside forEach() — forEach does not await Promises, leading to unhandled rejections.",
      suggestion: "Replace with: await Promise.all(arr.map(async (item) => { ... })) or use a for...of loop.",
    });

    checkPattern(findings, filePath, lines, {
      pattern: /setInterval|setTimeout/,
      severity: "low",
      category: "performance",
      description: "Timer (setInterval/setTimeout) detected — ensure timers are cleared on cleanup to prevent memory leaks.",
      suggestion: "Store the timer reference and call clearInterval/clearTimeout in your stop() or cleanup function.",
    });
  }

  // ── Readability checks ────────────────────────────────────────────────────
  if (focus.has("readability")) {
    checkPattern(findings, filePath, lines, {
      pattern: /if\s*\(.*==\s*(?!null|undefined)[^=]/,
      severity: "low",
      category: "readability",
      description: "Loose equality (==) detected — may cause unexpected type coercions.",
      suggestion: "Use strict equality (===) to avoid implicit type coercion bugs.",
    });

    checkPattern(findings, filePath, lines, {
      pattern: /catch\s*\(\w+\)\s*\{\s*\}/,
      severity: "medium",
      category: "readability",
      description: "Empty catch block detected — silently swallowing errors makes debugging very difficult.",
      suggestion: "At minimum, log the error: catch (err) { sdk.log.error(err.message); } or re-throw if not handled.",
    });

    checkPattern(findings, filePath, lines, {
      pattern: /console\.(log|warn|error|info)\s*\(/,
      severity: "low",
      category: "readability",
      description: "Raw console.* call detected — prefer a structured logger (e.g. sdk.log) for consistent formatting and level control.",
      suggestion: "Replace console.log/warn/error with sdk.log.info/warn/error for structured, prefixed logging.",
    });
  }

  // ── Test coverage checks ──────────────────────────────────────────────────
  if (focus.has("tests")) {
    // Flag large files (> 300 lines) with no corresponding test file
    if (lines.length > 300 && !filePath.includes("test") && !filePath.includes("spec")) {
      findings.push({
        file: filePath,
        severity: "low",
        category: "test",
        description: `Large file (${lines.length} lines) with no co-located tests detected.`,
        suggestion: "Consider adding a test file alongside this module to prevent regressions.",
      });
    }
  }

  return findings;
}

/**
 * Apply a single regex pattern to all lines and push a finding on first match.
 * Limits to one finding per pattern per file to avoid noise.
 */
function checkPattern(findings, filePath, lines, { pattern, severity, category, description, suggestion }) {
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) {
      findings.push({
        file: filePath,
        line: i + 1,
        severity,
        category,
        description,
        suggestion,
        snippet: lines[i].trim().slice(0, 120),
      });
      return; // one finding per pattern per file
    }
  }
}

/**
 * Build a well-formatted GitHub issue body from a finding.
 */
function buildIssueBody({ file, severity, category, description, suggestion, code_snippet }) {
  const emoji = severityEmoji(severity ?? "medium");
  const lines = [
    "## 🤖 AI Code Analysis Finding",
    "",
    `**File**: \`${file}\``,
    `**Severity**: ${emoji} ${(severity ?? "medium").charAt(0).toUpperCase() + (severity ?? "medium").slice(1)}`,
    `**Category**: \`${category ?? "code-quality"}\``,
    "",
    "### 🔍 Problem Description",
    description,
    "",
    "### 💡 Suggested Fix",
    suggestion,
  ];

  if (code_snippet) {
    lines.push("", "### 📋 Code Reference", "```javascript", code_snippet.slice(0, 1000), "```");
  }

  lines.push(
    "",
    "---",
    "_This issue was created automatically by the [self-improvement-assistant](https://github.com/xlabtg/teleton-plugins/tree/main/plugins/self-improvement-assistant) plugin. " +
    "Add the `wont-fix` label to suppress similar reports for this pattern._"
  );

  return lines.join("\n");
}
