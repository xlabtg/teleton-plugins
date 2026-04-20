import { formatError } from "../utils.js";

export const emptyParameters = {
  type: "object",
  properties: {},
};

export function createTool(sdk, definition, handler) {
  return {
    category: "data-bearing",
    ...definition,
    execute: async (params = {}, context = {}) => {
      try {
        const data = await handler(params, context);
        return { success: true, data };
      } catch (err) {
        const error = formatError(err);
        sdk?.log?.warn?.(`${definition.name} failed: ${error}`);
        return { success: false, error };
      }
    },
  };
}

export const accountIdProperty = {
  type: "string",
  description: "Finam account ID from finam_get_accounts.",
};

export const symbolProperty = {
  type: "string",
  description: 'Finam instrument symbol in "TICKER@MIC" format, for example SBER@MISX.',
};
