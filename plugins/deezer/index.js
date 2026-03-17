/**
 * Deezer plugin -- search and send music via the @DeezerMusicBot inline bot
 *
 * Uses GramJS MTProto to query @DeezerMusicBot inline results and send them directly in chat.
 * Messages appear "via @DeezerMusicBot" just like typing @DeezerMusicBot in the Telegram input field.
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
  name: "deezer",
  version: "1.0.1",
  sdkVersion: ">=1.0.0",
  description: "Search and send music tracks in chat via Telegram's @DeezerMusicBot inline bot.",
};

export const tools = (sdk) => [
  {
    name: "deezer",
    description:
      "Search and send a music track in the current chat using Telegram's @DeezerMusicBot inline bot (Deezer). " +
      "Provide a search query (artist, song title, album) and optionally pick a result by index. " +
      "The track is sent directly into the chat via @DeezerMusicBot.",
    category: "action",
    scope: "always",

    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Music search query — artist, song title, or album (e.g. 'Daft Punk', 'Bohemian Rhapsody', 'Stromae Papaoutai')",
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
        const deezerBot = await client.getEntity("DeezerMusicBot");
        const peer = await client.getInputEntity(context.chatId);

        const results = await client.invoke(
          new Api.messages.GetInlineBotResults({
            bot: deezerBot,
            peer,
            query: params.query,
            offset: "",
          })
        );

        if (!results.results || results.results.length === 0) {
          return { success: false, error: `No tracks found for "${params.query}"` };
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
