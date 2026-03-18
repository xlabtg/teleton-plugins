/**
 * Integration tests for github-dev-assistant plugin.
 *
 * Tests full tool call flows using mocked GitHub API responses.
 * Verifies: tool input validation, API call construction, content output shape,
 * and the require_pr_review policy guard.
 *
 * NOTE: Tools now take only sdk (not client + sdk). The GitHub client is
 * created internally per execution using sdk.secrets for the PAT token.
 * We mock global.fetch to intercept API calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { buildRepoOpsTools } from "../lib/repo-ops.js";
import { buildPRManagerTools } from "../lib/pr-manager.js";
import { buildIssueTrackerTools } from "../lib/issue-tracker.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSdk(config = {}, token = "ghp_testtoken") {
  return {
    secrets: {
      get: (key) => (key === "github_token" ? token : null),
      set: vi.fn(),
      delete: vi.fn(),
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    pluginConfig: {
      default_branch: "main",
      commit_author_name: "Test Agent",
      commit_author_email: "agent@test.local",
      require_pr_review: false,
      ...config,
    },
    llm: { confirm: vi.fn() },
  };
}

/**
 * Create a mock fetch that returns different responses based on
 * method + URL patterns.
 *
 * @param {Array<{match: RegExp|string, method?: string, status: number, body: any}>} routes
 */
function mockFetchRoutes(routes) {
  return vi.fn().mockImplementation(async (url, opts) => {
    const method = (opts?.method ?? "GET").toUpperCase();
    for (const route of routes) {
      const urlMatch =
        typeof route.match === "string" ? url.includes(route.match) : route.match.test(url);
      const methodMatch = !route.method || route.method.toUpperCase() === method;
      if (urlMatch && methodMatch) {
        const status = route.status ?? 200;
        return {
          ok: status >= 200 && status < 300,
          status,
          headers: { get: () => null },
          text: async () =>
            typeof route.body === "string" ? route.body : JSON.stringify(route.body),
        };
      }
    }
    throw new Error(`Unmatched fetch: ${method} ${url}`);
  });
}

function findTool(tools, name) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool '${name}' not found`);
  return tool;
}

// ---------------------------------------------------------------------------
// Repo ops tests
// ---------------------------------------------------------------------------

describe("github_list_repos", () => {
  let originalFetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

  it("returns formatted list of repos for authenticated user", async () => {
    const sdk = makeSdk();
    global.fetch = mockFetchRoutes([
      {
        match: "/user/repos",
        body: [
          { id: 1, name: "hello", full_name: "octocat/hello", private: false,
            html_url: "https://github.com/octocat/hello", language: "JavaScript",
            description: "My greeting tool", stargazers_count: 10 },
        ],
      },
      {
        match: "/user",
        method: "GET",
        body: { login: "octocat" },
      },
    ]);

    const tools = buildRepoOpsTools(sdk);
    const tool = findTool(tools, "github_list_repos");
    const result = await tool.execute({});

    expect(result.content).toMatch(/hello/);
    expect(result.content).toMatch(/JavaScript/);
    expect(result.content).toMatch(/public/);
  });

  it("returns error message for invalid type enum", async () => {
    const sdk = makeSdk();
    const tools = buildRepoOpsTools(sdk);
    const tool = findTool(tools, "github_list_repos");

    const result = await tool.execute({ owner: "octocat", type: "not-valid" });
    expect(result.content).toMatch(/Error/);
    expect(result.content).toMatch(/not-valid/);
  });
});

describe("github_create_repo", () => {
  let originalFetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

  it("creates repo and returns URL in content", async () => {
    const sdk = makeSdk();
    global.fetch = mockFetchRoutes([
      {
        match: "/user/repos",
        method: "POST",
        status: 201,
        body: {
          id: 999, name: "new-repo", full_name: "octocat/new-repo",
          private: false, html_url: "https://github.com/octocat/new-repo",
        },
      },
    ]);

    const tools = buildRepoOpsTools(sdk);
    const tool = findTool(tools, "github_create_repo");
    const result = await tool.execute({ name: "new-repo", description: "Test" });

    expect(result.content).toMatch(/new-repo/);
    expect(result.content).toMatch(/github\.com/);
  });

  it("requires name parameter", async () => {
    const sdk = makeSdk();
    const tools = buildRepoOpsTools(sdk);
    const tool = findTool(tools, "github_create_repo");

    const result = await tool.execute({});
    expect(result.content).toMatch(/Error/);
    expect(result.content).toMatch(/name/);
  });
});

describe("github_get_file", () => {
  let originalFetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

  it("returns decoded file content", async () => {
    const sdk = makeSdk();
    const fileContent = "Hello, world!";
    const b64 = Buffer.from(fileContent).toString("base64");

    global.fetch = mockFetchRoutes([
      {
        match: "/contents/README.md",
        body: {
          type: "file", name: "README.md", path: "README.md",
          sha: "abc123", size: fileContent.length,
          content: b64 + "\n",
          encoding: "base64",
          html_url: "https://github.com/octocat/hello/blob/main/README.md",
        },
      },
    ]);

    const tools = buildRepoOpsTools(sdk);
    const tool = findTool(tools, "github_get_file");
    const result = await tool.execute({ owner: "octocat", repo: "hello", path: "README.md" });

    expect(result.content).toMatch(/README\.md/);
    expect(result.content).toMatch(/Hello, world!/);
  });

  it("returns directory listing when path is a dir", async () => {
    const sdk = makeSdk();
    global.fetch = mockFetchRoutes([
      {
        match: "/contents/src",
        body: [
          { name: "index.js", path: "src/index.js", type: "file", size: 100 },
          { name: "utils.js", path: "src/utils.js", type: "file", size: 200 },
        ],
      },
    ]);

    const tools = buildRepoOpsTools(sdk);
    const tool = findTool(tools, "github_get_file");
    const result = await tool.execute({ owner: "octocat", repo: "hello", path: "src" });

    expect(result.content).toMatch(/index\.js/);
    expect(result.content).toMatch(/utils\.js/);
  });

  it("requires owner, repo, and path", async () => {
    const sdk = makeSdk();
    const tools = buildRepoOpsTools(sdk);
    const tool = findTool(tools, "github_get_file");

    const result = await tool.execute({ owner: "octocat" });
    expect(result.content).toMatch(/Error/);
    expect(result.content).toMatch(/repo/);
  });
});

describe("github_update_file", () => {
  let originalFetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

  it("encodes content and returns success message", async () => {
    const sdk = makeSdk();
    let capturedBody;
    global.fetch = vi.fn().mockImplementation(async (url, opts) => {
      if (opts?.method === "PUT") {
        capturedBody = JSON.parse(opts.body);
        return {
          ok: true, status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify({
            content: { sha: "new-sha", path: "README.md" },
            commit: { sha: "commit-sha", html_url: "https://github.com/octocat/hello/commit/commit-sha" },
          }),
        };
      }
      throw new Error(`Unexpected fetch: ${opts?.method} ${url}`);
    });

    const tools = buildRepoOpsTools(sdk);
    const tool = findTool(tools, "github_update_file");
    const result = await tool.execute({
      owner: "octocat", repo: "hello", path: "README.md",
      content: "# Hello World", message: "Update README",
    });

    expect(result.content).toMatch(/README\.md/);
    expect(result.content).toMatch(/created|updated/i);
    // Verify content was base64-encoded
    expect(Buffer.from(capturedBody.content, "base64").toString()).toBe("# Hello World");
    expect(capturedBody.message).toBe("Update README");
    expect(capturedBody.committer.name).toBe("Test Agent");
  });
});

describe("github_create_branch", () => {
  let originalFetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

  it("creates branch from specified ref and returns confirmation", async () => {
    const sdk = makeSdk();
    global.fetch = mockFetchRoutes([
      {
        match: "/git/ref/heads/main",
        method: "GET",
        body: { object: { sha: "base-sha-123" } },
      },
      {
        match: "/git/refs",
        method: "POST",
        status: 201,
        body: { ref: "refs/heads/feat/new-feature", object: { sha: "base-sha-123" } },
      },
    ]);

    const tools = buildRepoOpsTools(sdk);
    const tool = findTool(tools, "github_create_branch");
    const result = await tool.execute({
      owner: "octocat", repo: "hello", branch: "feat/new-feature", from_ref: "main",
    });

    expect(result.content).toMatch(/feat\/new-feature/);
    expect(result.content).toMatch(/main/);
  });
});

// ---------------------------------------------------------------------------
// PR manager tests
// ---------------------------------------------------------------------------

describe("github_create_pr", () => {
  let originalFetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

  it("creates PR and returns number + URL in content", async () => {
    const sdk = makeSdk();
    global.fetch = mockFetchRoutes([
      {
        match: "/pulls",
        method: "POST",
        status: 201,
        body: {
          number: 7, title: "Add feature", state: "open",
          head: { label: "octocat:feat/my-feature", sha: "abc" },
          base: { label: "octocat:main" },
          html_url: "https://github.com/octocat/hello/pull/7",
          user: { login: "octocat" }, draft: false,
        },
      },
    ]);

    const tools = buildPRManagerTools(sdk);
    const tool = findTool(tools, "github_create_pr");
    const result = await tool.execute({
      owner: "octocat", repo: "hello",
      title: "Add feature", head: "feat/my-feature",
    });

    expect(result.content).toMatch(/#7/);
    expect(result.content).toMatch(/github\.com/);
  });
});

describe("github_merge_pr - require_pr_review policy", () => {
  let originalFetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

  it("merges without confirmation when require_pr_review is false", async () => {
    const sdk = makeSdk({ require_pr_review: false });
    global.fetch = mockFetchRoutes([
      {
        match: "/pulls/7/merge",
        method: "PUT",
        body: { merged: true, sha: "merge-sha", message: "Merged" },
      },
    ]);

    const tools = buildPRManagerTools(sdk);
    const tool = findTool(tools, "github_merge_pr");
    const result = await tool.execute({ owner: "octocat", repo: "hello", pr_number: 7 });

    expect(result.content).toMatch(/merged/i);
    expect(sdk.llm.confirm).not.toHaveBeenCalled();
  });

  it("asks for confirmation when require_pr_review is true", async () => {
    const sdk = makeSdk({ require_pr_review: true });
    sdk.llm.confirm = vi.fn().mockResolvedValue(true); // user says yes

    global.fetch = mockFetchRoutes([
      {
        match: "/pulls/7",
        method: "GET",
        body: { number: 7, title: "Dangerous merge", state: "open",
          head: { label: "feat", sha: "abc" }, base: { label: "main" },
          html_url: "...", user: { login: "octocat" } },
      },
      {
        match: "/pulls/7/merge",
        method: "PUT",
        body: { merged: true, sha: "merge-sha", message: "Merged" },
      },
    ]);

    const tools = buildPRManagerTools(sdk);
    const tool = findTool(tools, "github_merge_pr");
    const result = await tool.execute({ owner: "octocat", repo: "hello", pr_number: 7 });

    expect(sdk.llm.confirm).toHaveBeenCalled();
    expect(result.content).toMatch(/merged/i);
  });

  it("cancels merge when user declines confirmation", async () => {
    const sdk = makeSdk({ require_pr_review: true });
    sdk.llm.confirm = vi.fn().mockResolvedValue(false); // user says no

    global.fetch = mockFetchRoutes([
      {
        match: "/pulls/7",
        method: "GET",
        body: { number: 7, title: "Risky merge", state: "open",
          head: { label: "feat", sha: "abc" }, base: { label: "main" },
          html_url: "...", user: { login: "octocat" } },
      },
    ]);

    const tools = buildPRManagerTools(sdk);
    const tool = findTool(tools, "github_merge_pr");
    const result = await tool.execute({ owner: "octocat", repo: "hello", pr_number: 7 });

    expect(result.content).toMatch(/cancelled/i);
    // No merge call should be made
    const mergeCalls = global.fetch.mock.calls.filter(([url, opts]) =>
      url.includes("/merge") && opts?.method === "PUT"
    );
    expect(mergeCalls).toHaveLength(0);
  });

  it("skips confirmation when skip_review_check is true", async () => {
    const sdk = makeSdk({ require_pr_review: true });
    global.fetch = mockFetchRoutes([
      {
        match: "/pulls/7/merge",
        method: "PUT",
        body: { merged: true, sha: "merge-sha", message: "Merged" },
      },
    ]);

    const tools = buildPRManagerTools(sdk);
    const tool = findTool(tools, "github_merge_pr");
    const result = await tool.execute({
      owner: "octocat", repo: "hello", pr_number: 7,
      skip_review_check: true,
    });

    expect(sdk.llm.confirm).not.toHaveBeenCalled();
    expect(result.content).toMatch(/merged/i);
  });

  it("validates merge_method enum", async () => {
    const sdk = makeSdk();
    const tools = buildPRManagerTools(sdk);
    const tool = findTool(tools, "github_merge_pr");

    const result = await tool.execute({
      owner: "octocat", repo: "hello", pr_number: 7, merge_method: "invalid",
    });
    expect(result.content).toMatch(/Error/);
    expect(result.content).toMatch(/invalid/);
  });
});

// ---------------------------------------------------------------------------
// Issue tracker tests
// ---------------------------------------------------------------------------

describe("github_create_issue", () => {
  let originalFetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

  it("creates issue and returns number + URL in content", async () => {
    const sdk = makeSdk();
    global.fetch = mockFetchRoutes([
      {
        match: "/issues",
        method: "POST",
        status: 201,
        body: {
          number: 15, title: "Bug: crash on startup", state: "open",
          html_url: "https://github.com/octocat/hello/issues/15",
          user: { login: "octocat" }, assignees: [{ login: "reviewer" }],
          labels: [{ name: "bug" }],
        },
      },
    ]);

    const tools = buildIssueTrackerTools(sdk);
    const tool = findTool(tools, "github_create_issue");
    const result = await tool.execute({
      owner: "octocat", repo: "hello",
      title: "Bug: crash on startup",
      body: "Steps to reproduce...",
      labels: ["bug"],
      assignees: ["reviewer"],
    });

    expect(result.content).toMatch(/#15/);
    expect(result.content).toMatch(/github\.com/);
  });

  it("requires title parameter", async () => {
    const sdk = makeSdk();
    const tools = buildIssueTrackerTools(sdk);
    const tool = findTool(tools, "github_create_issue");
    const result = await tool.execute({ owner: "o", repo: "r" });
    expect(result.content).toMatch(/Error/);
    expect(result.content).toMatch(/title/);
  });
});

describe("github_close_issue", () => {
  let originalFetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

  it("closes issue with comment and returns confirmation", async () => {
    const sdk = makeSdk();
    global.fetch = mockFetchRoutes([
      {
        match: "/issues/20/comments",
        method: "POST",
        status: 201,
        body: { id: 100, html_url: "...", body: "Closing comment", user: { login: "octocat" } },
      },
      {
        match: "/issues/20",
        method: "PATCH",
        body: {
          number: 20, title: "Old issue", state: "closed", state_reason: "not_planned",
          html_url: "https://github.com/octocat/hello/issues/20",
          user: { login: "octocat" },
        },
      },
    ]);

    const tools = buildIssueTrackerTools(sdk);
    const tool = findTool(tools, "github_close_issue");
    const result = await tool.execute({
      owner: "octocat", repo: "hello", issue_number: 20,
      comment: "Closing as not planned.", reason: "not_planned",
    });

    expect(result.content).toMatch(/#20/);
    expect(result.content).toMatch(/closed/i);
    expect(result.content).toMatch(/won't fix|not_planned/i);
  });
});

describe("github_trigger_workflow", () => {
  let originalFetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

  it("triggers workflow and returns confirmation", async () => {
    const sdk = makeSdk();
    global.fetch = mockFetchRoutes([
      {
        match: "/dispatches",
        method: "POST",
        status: 204,
        body: null,
      },
    ]);

    const tools = buildIssueTrackerTools(sdk);
    const tool = findTool(tools, "github_trigger_workflow");
    const result = await tool.execute({
      owner: "octocat", repo: "hello",
      workflow_id: "ci.yml", ref: "main",
      inputs: { environment: "staging" },
    });

    expect(result.content).toMatch(/ci\.yml/);
    expect(result.content).toMatch(/triggered/i);
  });

  it("requires workflow_id and ref", async () => {
    const sdk = makeSdk();
    const tools = buildIssueTrackerTools(sdk);
    const tool = findTool(tools, "github_trigger_workflow");
    const result = await tool.execute({ owner: "o", repo: "r", workflow_id: "ci.yml" });
    expect(result.content).toMatch(/Error/);
    expect(result.content).toMatch(/ref/);
  });
});

// ---------------------------------------------------------------------------
// Error handling tests
// ---------------------------------------------------------------------------

describe("GitHub API error handling", () => {
  let originalFetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

  it("returns content with error message on API failure", async () => {
    const sdk = makeSdk();
    global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    const tools = buildRepoOpsTools(sdk);
    const tool = findTool(tools, "github_list_repos");
    const result = await tool.execute({ owner: "someone" });

    expect(result.content).toMatch(/Failed/i);
    expect(result.content).toMatch(/Network error/);
  });

  it("redacts token patterns from error messages", async () => {
    const sdk = makeSdk();
    global.fetch = vi.fn().mockRejectedValue(
      new Error("Token ghp_abc123secretXYZ is invalid")
    );

    const tools = buildRepoOpsTools(sdk);
    const tool = findTool(tools, "github_list_repos");
    const result = await tool.execute({});

    // The raw token should be redacted by formatError
    expect(result.content).not.toContain("ghp_abc123secretXYZ");
    expect(result.content).toContain("[REDACTED]");
  });
});
