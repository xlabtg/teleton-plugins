/**
 * Integration tests for github-dev-assistant plugin.
 *
 * Tests full tool call flows using mocked GitHub API responses.
 * Verifies: tool input validation, API call construction, output shape,
 * and the require_pr_review policy guard.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We test tools by building them directly with mocked client/sdk
import { buildRepoOpsTools } from "../lib/repo-ops.js";
import { buildPRManagerTools } from "../lib/pr-manager.js";
import { buildIssueTrackerTools } from "../lib/issue-tracker.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSdk(config = {}) {
  return {
    secrets: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
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

function makeClient(responses = {}) {
  return {
    isAuthenticated: () => true,
    get: vi.fn(async (path) => {
      if (responses[path]) return responses[path];
      throw new Error(`Unexpected GET ${path}`);
    }),
    getPaginated: vi.fn(async (path) => {
      if (responses[path]) return { data: responses[path], pagination: {} };
      return { data: [], pagination: {} };
    }),
    post: vi.fn(async (path, body) => {
      if (responses[`POST:${path}`]) return responses[`POST:${path}`];
      // Default: echo back the body with an id
      return { id: 1, number: 42, ...body, html_url: `https://github.com${path}` };
    }),
    put: vi.fn(async (path, body) => {
      if (responses[`PUT:${path}`]) return responses[`PUT:${path}`];
      return { content: { sha: "new-sha", path: "file.txt" }, commit: { sha: "commit-sha", html_url: "https://github.com" } };
    }),
    patch: vi.fn(async (path, body) => {
      if (responses[`PATCH:${path}`]) return responses[`PATCH:${path}`];
      return { number: 1, state: "closed", html_url: "https://github.com/issue/1", user: { login: "octocat" }, ...body };
    }),
    delete: vi.fn(async () => null),
    postRaw: vi.fn(async () => ({ status: 204, data: null })),
  };
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
  it("returns repos for authenticated user", async () => {
    const sdk = makeSdk();
    const client = makeClient({
      "/user": { login: "octocat" },
      "/user/repos": [
        { id: 1, name: "hello", full_name: "octocat/hello", private: false, fork: false,
          html_url: "https://github.com/octocat/hello", clone_url: "", ssh_url: "",
          default_branch: "main", language: "JavaScript", stargazers_count: 10,
          forks_count: 2, open_issues_count: 0, size: 100, topics: [], visibility: "public" },
      ],
    });

    const tools = buildRepoOpsTools(client, sdk);
    const tool = findTool(tools, "github_list_repos");
    const result = await tool.execute({});

    expect(result.success).toBe(true);
    expect(result.data.repos).toHaveLength(1);
    expect(result.data.repos[0].name).toBe("hello");
  });

  it("returns error for invalid type enum", async () => {
    const sdk = makeSdk();
    const client = makeClient({});
    const tools = buildRepoOpsTools(client, sdk);
    const tool = findTool(tools, "github_list_repos");

    const result = await tool.execute({ owner: "octocat", type: "not-valid" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not-valid/);
  });
});

describe("github_create_repo", () => {
  it("creates repo and returns formatted data", async () => {
    const sdk = makeSdk();
    const client = makeClient();
    client.post = vi.fn().mockResolvedValue({
      id: 999, name: "new-repo", full_name: "octocat/new-repo",
      description: "Test", private: false, fork: false,
      html_url: "https://github.com/octocat/new-repo",
      clone_url: "https://github.com/octocat/new-repo.git",
      ssh_url: "git@github.com:octocat/new-repo.git",
      default_branch: "main", language: null, stargazers_count: 0,
      forks_count: 0, open_issues_count: 0, size: 0, topics: [], visibility: "public",
    });

    const tools = buildRepoOpsTools(client, sdk);
    const tool = findTool(tools, "github_create_repo");
    const result = await tool.execute({ name: "new-repo", description: "Test" });

    expect(result.success).toBe(true);
    expect(result.data.name).toBe("new-repo");
    expect(result.data.url).toContain("github.com");
  });

  it("requires name parameter", async () => {
    const sdk = makeSdk();
    const client = makeClient();
    const tools = buildRepoOpsTools(client, sdk);
    const tool = findTool(tools, "github_create_repo");

    const result = await tool.execute({});
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/name/);
  });
});

describe("github_get_file", () => {
  it("decodes base64 file content", async () => {
    const sdk = makeSdk();
    const fileContent = "Hello, world!";
    const b64 = Buffer.from(fileContent).toString("base64");

    const client = makeClient({
      "/repos/octocat/hello/contents/README.md": {
        type: "file", name: "README.md", path: "README.md",
        sha: "abc123", size: fileContent.length,
        content: b64 + "\n", // GitHub adds a newline
        encoding: "base64",
        html_url: "https://github.com/octocat/hello/blob/main/README.md",
        download_url: "https://raw.githubusercontent.com/octocat/hello/main/README.md",
      },
    });

    const tools = buildRepoOpsTools(client, sdk);
    const tool = findTool(tools, "github_get_file");
    const result = await tool.execute({ owner: "octocat", repo: "hello", path: "README.md" });

    expect(result.success).toBe(true);
    expect(result.data.content).toBe(fileContent);
    expect(result.data.type).toBe("file");
    expect(result.data.sha).toBe("abc123");
  });

  it("returns directory listing when path is a dir", async () => {
    const sdk = makeSdk();
    const client = makeClient({
      "/repos/octocat/hello/contents/src": [
        { name: "index.js", path: "src/index.js", type: "file", size: 100, sha: "def456" },
        { name: "utils.js", path: "src/utils.js", type: "file", size: 200, sha: "ghi789" },
      ],
    });

    const tools = buildRepoOpsTools(client, sdk);
    const tool = findTool(tools, "github_get_file");
    const result = await tool.execute({ owner: "octocat", repo: "hello", path: "src" });

    expect(result.success).toBe(true);
    expect(result.data.type).toBe("dir");
    expect(result.data.entries).toHaveLength(2);
  });

  it("requires owner, repo, and path", async () => {
    const sdk = makeSdk();
    const client = makeClient();
    const tools = buildRepoOpsTools(client, sdk);
    const tool = findTool(tools, "github_get_file");

    const result = await tool.execute({ owner: "octocat" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/repo/);
  });
});

describe("github_update_file", () => {
  it("encodes content and sends put request", async () => {
    const sdk = makeSdk();
    const client = makeClient();
    const tools = buildRepoOpsTools(client, sdk);
    const tool = findTool(tools, "github_update_file");

    const result = await tool.execute({
      owner: "octocat", repo: "hello", path: "README.md",
      content: "# Hello World", message: "Update README",
    });

    expect(result.success).toBe(true);
    // Verify put was called with base64-encoded content
    const callArgs = client.put.mock.calls[0];
    expect(callArgs[0]).toContain("/contents/README.md");
    const body = callArgs[1];
    expect(Buffer.from(body.content, "base64").toString()).toBe("# Hello World");
    expect(body.message).toBe("Update README");
    expect(body.committer.name).toBe("Test Agent");
  });
});

describe("github_create_branch", () => {
  it("creates branch from specified ref", async () => {
    const sdk = makeSdk();
    const client = makeClient({
      "/repos/octocat/hello/git/ref/heads/main": {
        object: { sha: "base-sha-123" },
      },
    });
    client.post = vi.fn().mockResolvedValue({
      ref: "refs/heads/feat/new-feature",
      object: { sha: "base-sha-123" },
    });

    const tools = buildRepoOpsTools(client, sdk);
    const tool = findTool(tools, "github_create_branch");
    const result = await tool.execute({
      owner: "octocat", repo: "hello", branch: "feat/new-feature", from_ref: "main",
    });

    expect(result.success).toBe(true);
    expect(result.data.branch).toBe("feat/new-feature");
    expect(result.data.source_sha).toBe("base-sha-123");
  });
});

// ---------------------------------------------------------------------------
// PR manager tests
// ---------------------------------------------------------------------------

describe("github_create_pr", () => {
  it("creates PR with default base branch", async () => {
    const sdk = makeSdk();
    const client = makeClient();
    client.post = vi.fn().mockResolvedValue({
      number: 7, title: "Add feature", state: "open",
      head: { label: "octocat:feat/my-feature", sha: "abc" },
      base: { label: "octocat:main" },
      html_url: "https://github.com/octocat/hello/pull/7",
      user: { login: "octocat" }, draft: false, merged: false,
      assignees: [], labels: [], requested_reviewers: [],
    });

    const tools = buildPRManagerTools(client, sdk);
    const tool = findTool(tools, "github_create_pr");
    const result = await tool.execute({
      owner: "octocat", repo: "hello",
      title: "Add feature", head: "feat/my-feature",
    });

    expect(result.success).toBe(true);
    expect(result.data.number).toBe(7);
    expect(result.data.state).toBe("open");

    const body = client.post.mock.calls[0][1];
    expect(body.base).toBe("main"); // defaults to plugin config
  });
});

describe("github_merge_pr - require_pr_review policy", () => {
  it("merges without confirmation when require_pr_review is false", async () => {
    const sdk = makeSdk({ require_pr_review: false });
    const client = makeClient();
    client.put = vi.fn().mockResolvedValue({ merged: true, sha: "merge-sha", message: "Merged" });

    const tools = buildPRManagerTools(client, sdk);
    const tool = findTool(tools, "github_merge_pr");
    const result = await tool.execute({ owner: "octocat", repo: "hello", pr_number: 7 });

    expect(result.success).toBe(true);
    expect(result.data.merged).toBe(true);
    expect(sdk.llm.confirm).not.toHaveBeenCalled();
  });

  it("asks for confirmation when require_pr_review is true", async () => {
    const sdk = makeSdk({ require_pr_review: true });
    sdk.llm.confirm = vi.fn().mockResolvedValue(true); // user says yes

    const client = makeClient({
      "/repos/octocat/hello/pulls/7": {
        number: 7, title: "Dangerous merge", state: "open",
        head: { label: "feat", sha: "abc" }, base: { label: "main" },
        html_url: "...", user: { login: "octocat" },
      },
    });
    client.put = vi.fn().mockResolvedValue({ merged: true, sha: "merge-sha", message: "Merged" });

    const tools = buildPRManagerTools(client, sdk);
    const tool = findTool(tools, "github_merge_pr");
    const result = await tool.execute({ owner: "octocat", repo: "hello", pr_number: 7 });

    expect(sdk.llm.confirm).toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it("cancels merge when user declines confirmation", async () => {
    const sdk = makeSdk({ require_pr_review: true });
    sdk.llm.confirm = vi.fn().mockResolvedValue(false); // user says no

    const client = makeClient({
      "/repos/octocat/hello/pulls/7": {
        number: 7, title: "Risky merge", state: "open",
        head: { label: "feat", sha: "abc" }, base: { label: "main" },
        html_url: "...", user: { login: "octocat" },
      },
    });

    const tools = buildPRManagerTools(client, sdk);
    const tool = findTool(tools, "github_merge_pr");
    const result = await tool.execute({ owner: "octocat", repo: "hello", pr_number: 7 });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cancelled/i);
    expect(client.put).not.toHaveBeenCalled();
  });

  it("skips confirmation when skip_review_check is true", async () => {
    const sdk = makeSdk({ require_pr_review: true });
    const client = makeClient();
    client.put = vi.fn().mockResolvedValue({ merged: true, sha: "merge-sha", message: "Merged" });

    const tools = buildPRManagerTools(client, sdk);
    const tool = findTool(tools, "github_merge_pr");
    const result = await tool.execute({
      owner: "octocat", repo: "hello", pr_number: 7,
      skip_review_check: true,
    });

    expect(sdk.llm.confirm).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it("validates merge_method enum", async () => {
    const sdk = makeSdk();
    const client = makeClient();
    const tools = buildPRManagerTools(client, sdk);
    const tool = findTool(tools, "github_merge_pr");

    const result = await tool.execute({
      owner: "octocat", repo: "hello", pr_number: 7, merge_method: "invalid",
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/invalid/);
  });
});

// ---------------------------------------------------------------------------
// Issue tracker tests
// ---------------------------------------------------------------------------

describe("github_create_issue", () => {
  it("creates issue with labels and assignees", async () => {
    const sdk = makeSdk();
    const client = makeClient();
    client.post = vi.fn().mockResolvedValue({
      number: 15, title: "Bug: crash on startup", state: "open",
      html_url: "https://github.com/octocat/hello/issues/15",
      user: { login: "octocat" }, assignees: [{ login: "reviewer" }],
      labels: [{ name: "bug" }], milestone: null, comments: 0,
      body: "Steps to reproduce...", locked: false,
      created_at: "2024-01-01T00:00:00Z",
    });

    const tools = buildIssueTrackerTools(client, sdk);
    const tool = findTool(tools, "github_create_issue");
    const result = await tool.execute({
      owner: "octocat", repo: "hello",
      title: "Bug: crash on startup",
      body: "Steps to reproduce...",
      labels: ["bug"],
      assignees: ["reviewer"],
    });

    expect(result.success).toBe(true);
    expect(result.data.number).toBe(15);
    expect(result.data.labels).toContain("bug");
    expect(result.data.assignees).toContain("reviewer");
  });

  it("requires title parameter", async () => {
    const sdk = makeSdk();
    const tools = buildIssueTrackerTools(makeClient(), sdk);
    const tool = findTool(tools, "github_create_issue");
    const result = await tool.execute({ owner: "o", repo: "r" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/title/);
  });
});

describe("github_close_issue", () => {
  it("closes issue with comment and reason", async () => {
    const sdk = makeSdk();
    const client = makeClient();
    client.post = vi.fn().mockResolvedValue({
      id: 100, html_url: "...", body: "Closing comment",
      user: { login: "octocat" }, created_at: "2024-01-01T00:00:00Z",
    });
    client.patch = vi.fn().mockResolvedValue({
      number: 20, title: "Old issue", state: "closed", state_reason: "not_planned",
      html_url: "https://github.com/octocat/hello/issues/20",
      user: { login: "octocat" }, assignees: [], labels: [], comments: 1,
      locked: false, pull_request: false,
    });

    const tools = buildIssueTrackerTools(client, sdk);
    const tool = findTool(tools, "github_close_issue");
    const result = await tool.execute({
      owner: "octocat", repo: "hello", issue_number: 20,
      comment: "Closing as not planned.", reason: "not_planned",
    });

    expect(result.success).toBe(true);
    expect(result.data.state).toBe("closed");
    // Comment was posted first
    expect(client.post).toHaveBeenCalledWith(
      expect.stringContaining("/issues/20/comments"),
      { body: "Closing as not planned." }
    );
  });
});

describe("github_trigger_workflow", () => {
  it("triggers workflow and returns confirmation", async () => {
    const sdk = makeSdk();
    const client = makeClient();
    client.postRaw = vi.fn().mockResolvedValue({ status: 204, data: null });

    const tools = buildIssueTrackerTools(client, sdk);
    const tool = findTool(tools, "github_trigger_workflow");
    const result = await tool.execute({
      owner: "octocat", repo: "hello",
      workflow_id: "ci.yml", ref: "main",
      inputs: { environment: "staging" },
    });

    expect(result.success).toBe(true);
    expect(result.data.workflow_id).toBe("ci.yml");
    expect(result.data.message).toContain("ci.yml");
  });

  it("requires workflow_id and ref", async () => {
    const sdk = makeSdk();
    const tools = buildIssueTrackerTools(makeClient(), sdk);
    const tool = findTool(tools, "github_trigger_workflow");
    const result = await tool.execute({ owner: "o", repo: "r", workflow_id: "ci.yml" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ref/);
  });
});

// ---------------------------------------------------------------------------
// Error handling tests
// ---------------------------------------------------------------------------

describe("GitHub API error handling", () => {
  it("returns structured error on API failure", async () => {
    const sdk = makeSdk();
    const client = makeClient();
    client.getPaginated = vi.fn().mockRejectedValue(
      Object.assign(new Error("Not authenticated. Run github_auth to connect."), { status: 401 })
    );

    const tools = buildRepoOpsTools(client, sdk);
    const tool = findTool(tools, "github_list_repos");
    const result = await tool.execute({ owner: "someone" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Not authenticated");
  });

  it("redacts token patterns from error messages", async () => {
    const sdk = makeSdk();
    const client = makeClient();
    client.getPaginated = vi.fn().mockRejectedValue(
      new Error("Token ghp_abc123secretXYZ is invalid")
    );

    const tools = buildRepoOpsTools(client, sdk);
    const tool = findTool(tools, "github_list_repos");
    const result = await tool.execute({});

    expect(result.success).toBe(false);
    // The raw token should be redacted by formatError
    expect(result.error).not.toContain("ghp_abc123secretXYZ");
    expect(result.error).toContain("[REDACTED]");
  });
});
