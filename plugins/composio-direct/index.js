/**
 * Composio Direct Plugin for Teleton
 * Provides direct access to Composio tools without the meta-layer
 * Docs: https://docs.composio.dev
 */

const COMPOSIO_API_URL = "https://api.composio.dev/api/v1";

/**
 * Helper: make authenticated request to Composio API
 */
async function composioFetch(sdk, endpoint, options = {}) {
  const apiKey = sdk.config.composio_api_key || process.env.COMPOSIO_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Composio API key not set. Set COMPOSIO_API_KEY in config.yaml or environment."
    );
  }

  const res = await fetch(`${COMPOSIO_API_URL}${endpoint}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-COMPOSIO-API-KEY": apiKey,
      ...options.headers,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Composio API error ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.json();
}

/**
 * Tool: composio_search_tools
 * Search for available tools across all toolkits
 */
const composioSearchTools = {
  name: "composio_search_tools",
  description:
    "Search for available Composio tools. Use query to filter by name/toolkit. Returns list of tools with their parameters and descriptions.",
  category: "data-bearing",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query (e.g., 'github', 'slack', 'jira')",
      },
      toolkit: {
        type: "string",
        description: "Filter by toolkit slug (e.g., 'github', 'slack')",
      },
      limit: {
        type: "integer",
        description: "Max number of results (default: 50)",
        minimum: 1,
        maximum: 100,
      },
    },
  },
  execute: async (params, sdk) => {
    try {
      const { query = "", toolkit = "", limit = 50 } = params;

      // Build query parameters
      const searchParams = new URLSearchParams();
      if (query) searchParams.append("query", query);
      if (toolkit) searchParams.append("toolkit", toolkit);
      searchParams.append("limit", limit.toString());

      const data = await composioFetch(
        sdk,
        `/tools?${searchParams.toString()}`,
        { method: "GET" }
      );

      // Format results
      const tools = (data.items || []).map((tool) => ({
        name: tool.name,
        slug: tool.slug,
        description: tool.description,
        toolkit: tool.toolkit?.name || tool.toolkit,
        auth_schemes: tool.auth_schemes || [],
        tags: tool.tags || [],
      }));

      return {
        success: true,
        data: { tools, count: tools.length, query, toolkit },
      };
    } catch (err) {
      sdk?.log?.error(`composio_search_tools failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  },
};

/**
 * Tool: composio_execute_tool
 * Execute a specific tool by its slug with provided parameters
 */
const composioExecuteTool = {
  name: "composio_execute_tool",
  description:
    "Execute a Composio tool directly by its slug. Provide parameters as JSON. Returns the tool's output.",
  category: "action",
  parameters: {
    type: "object",
    properties: {
      tool_slug: {
        type: "string",
        description: "Tool slug (e.g., 'github_create_repo')",
      },
      parameters: {
        type: "object",
        description: "Tool parameters as JSON object",
      },
    },
    required: ["tool_slug", "parameters"],
  },
  execute: async (params, sdk) => {
    try {
      const { tool_slug, parameters } = params;
      if (!tool_slug || typeof parameters !== "object") {
        throw new Error("tool_slug and parameters (object) are required");
      }

      const data = await composioFetch(sdk, `/tools/${tool_slug}/execute`, {
        method: "POST",
        body: JSON.stringify(parameters),
      });

      return {
        success: true,
        data: data.result || data,
      };
    } catch (err) {
      sdk?.log?.error(`composio_execute_tool failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  },
};

/**
 * Tool: composio_multi_execute
 * Execute multiple tools in parallel
 */
const composioMultiExecute = {
  name: "composio_multi_execute",
  description:
    "Execute up to 50 tools in parallel. Provide an array of tool executions with tool_slug and parameters. Returns array of results.",
  category: "action",
  parameters: {
    type: "object",
    properties: {
      executions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            tool_slug: { type: "string" },
            parameters: { type: "object" },
          },
          required: ["tool_slug", "parameters"],
        },
        description: "Array of tool executions to run in parallel",
      },
    },
    required: ["executions"],
  },
  execute: async (params, sdk) => {
    try {
      const { executions } = params;
      if (!Array.isArray(executions) || executions.length === 0) {
        throw new Error("executions must be a non-empty array");
      }
      if (executions.length > 50) {
        throw new Error("Maximum 50 tools can be executed in parallel");
      }

      const data = await composioFetch(sdk, "/tools/execute-multi", {
        method: "POST",
        body: JSON.stringify({ executions }),
      });

      return {
        success: true,
        data: data.results || data,
      };
    } catch (err) {
      sdk?.log?.error(`composio_multi_execute failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  },
};

/**
 * Tool: composio_manage_connection
 * Manage OAuth connections for a toolkit (list, create, delete)
 */
const composioManageConnection = {
  name: "composio_manage_connection",
  description:
    "Manage connections for a toolkit: list existing connections, create new OAuth connection, or delete. Requires user approval for OAuth flows.",
  category: "action",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "create", "delete"],
        description: "Action to perform",
      },
      toolkit: {
        type: "string",
        description: "Toolkit slug (e.g., 'github', 'slack')",
      },
      connection_id: {
        type: "string",
        description: "Connection ID (required for delete)",
      },
      redirect_uri: {
        type: "string",
        description: "Redirect URI for OAuth (optional, defaults to plugin's callback)",
      },
    },
    required: ["action", "toolkit"],
  },
  execute: async (params, sdk) => {
    try {
      const { action, toolkit, connection_id, redirect_uri } = params;
      if (!action || !toolkit) {
        throw new Error("action and toolkit are required");
      }

      let endpoint = `/connections/${toolkit}`;
      const options = { method: action === "list" ? "GET" : "POST" };

      if (action === "delete") {
        if (!connection_id) throw new Error("connection_id required for delete");
        options.method = "DELETE";
        endpoint = `/connections/${toolkit}/${connection_id}`;
      } else if (action === "create") {
        options.body = JSON.stringify({ redirect_uri });
      }

      const data = await composioFetch(sdk, endpoint, options);

      return {
        success: true,
        data: data,
      };
    } catch (err) {
      sdk?.log?.error(`composio_manage_connection failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  },
};

// Export tools
export const tools = (sdk) => {
  return [
    composioSearchTools,
    composioExecuteTool,
    composioMultiExecute,
    composioManageConnection,
  ];
};
