/**
 * Vid plugin -- search and send YouTube videos via the @vid inline bot
 *
 * Uses GramJS MTProto to query @vid inline results and send them directly in chat.
 * Messages appear "via @vid" just like typing @vid in the Telegram input field.
 */

import { createRequire } from "node:module";
import { realpathSync } from "node:fs";

// Resolve "telegram" from teleton's own node_modules (not the plugin directory).
// realpathSync follows the symlink so createRequire looks in the right node_modules.
const _require = createRequire(realpathSync(process.argv[1]));
const { Api } = _require("telegram");

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const manifest = {
  name: "vid",
  version: "1.0.1",
  sdkVersion: ">=1.0.0",
  description: "Search and send YouTube videos in chat via Telegram's @vid inline bot.",
};

export const tools = (sdk) => [
  {
    name: "vid",
    description:
      "Search and send a YouTube video in the current chat using Telegram's @vid inline bot (YouTube Search). " +
      "Provide a search query and optionally pick a result by index. The video is sent directly into the chat via @vid.",
    category: "action",
    scope: "always",

    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "YouTube video search query (e.g. 'funny cat', 'TON blockchain', 'cooking tutorial')",
        },
        index: {
          type: "integer",
          description: "Which result to send (0 = first, 1 = second, etc.). Defaults to 0.",
          minimum: 0,
          maximum: 49,
        },
      },
      required: ["query"],
    },

    execute: async (params, context) => {
      try {
        const client = sdk.telegram.getRawClient();
        const vidBot = await client.getEntity("vid");
        const peer = await client.getInputEntity(context.chatId);

        const results = await client.invoke(
          new Api.messages.GetInlineBotResults({
            bot: vidBot,
            peer,
            query: params.query,
            offset: "",
          })
        );

        if (!results.results || results.results.length === 0) {
          return { success: false, error: `No YouTube videos found for "${params.query}"` };
        }

        const index = params.index ?? 0;
        if (index >= results.results.length) {
          return {
            success: false,
            error: `Only ${results.results.length} results available, index ${index} is out of range`,
          };
        }

        const chosen = results.results[index];

        await client.invoke(
          new Api.messages.SendInlineBotResult({
            peer,
            queryId: results.queryId,
            id: chosen.id,
            randomId: BigInt(Math.floor(Math.random() * 2 ** 62)),
          })
        );

        return {
          success: true,
          data: {
            query: params.query,
            sent_index: index,
            total_results: results.results.length,
            title: chosen.title || null,
            description: chosen.description || null,
            type: chosen.type || null,
          },
        };
      } catch (err) {
        return { success: false, error: String(err.message || err).slice(0, 500) };
      }
    },
  },
];
