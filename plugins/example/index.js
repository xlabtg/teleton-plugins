/**
 * Example plugin -- randomness toolkit (dice + picker)
 *
 * Copy this folder to start a new plugin:
 *   cp -r plugins/example plugins/your-plugin
 *
 * Then edit the tools below. Each tool needs:
 *   - name:        unique identifier (snake_case, no spaces)
 *   - description: the LLM reads this to decide when to call your tool
 *   - parameters:  JSON Schema describing what the LLM should pass in
 *   - execute:     async function that does the work and returns a result
 */

// ---------------------------------------------------------------------------
// Tool 1: dice_roll
// Shows: optional params with defaults, input validation, context usage
// ---------------------------------------------------------------------------

const diceRoll = {
  // Must be unique across all plugins. Collisions are silently skipped.
  name: "dice_roll",

  // The LLM sees this description and decides whether to call the tool.
  // Be specific -- vague descriptions lead to bad tool selection.
  description:
    "Roll one or more dice with configurable sides. Useful for games, decisions, or tabletop RPGs.",
  category: "action",
  scope: "always",

  // JSON Schema for the parameters the LLM will provide.
  // Every property here becomes a named argument in params.
  parameters: {
    type: "object",
    properties: {
      sides: {
        type: "integer",
        description: "Number of sides per die (2-100)",
        minimum: 2,
        maximum: 100,
      },
      count: {
        type: "integer",
        description: "Number of dice to roll (1-20)",
        minimum: 1,
        maximum: 20,
      },
      modifier: {
        type: "integer",
        description: "Bonus or penalty added to the total (can be negative)",
      },
    },
    // No "required" array here -- all params are optional with defaults below.
  },

  // execute(params, context) is called when the LLM invokes this tool.
  //
  // params  -- the arguments the LLM chose, matching the schema above
  // context -- Teleton runtime:
  //   context.bridge    TelegramBridge (send messages, reactions, media)
  //   context.db        SQLite database instance
  //   context.chatId    current chat ID
  //   context.senderId  Telegram user ID of whoever triggered this
  //   context.isGroup   true if group chat, false if DM
  //   context.config    agent config (may be undefined)
  //
  // Must return { success: true, data: { ... } } or { success: false, error: "..." }
  // The data object is serialized to JSON and fed back to the LLM.
  execute: async (params, context) => {
    const sides = params.sides ?? 6;
    const count = params.count ?? 1;
    const modifier = params.modifier ?? 0;

    // Validate input -- return an error object if something is wrong.
    if (sides < 2 || sides > 100) {
      return { success: false, error: `sides must be between 2 and 100 (got ${sides})` };
    }
    if (count < 1 || count > 20) {
      return { success: false, error: `count must be between 1 and 20 (got ${count})` };
    }

    const rolls = [];
    for (let i = 0; i < count; i++) {
      rolls.push(Math.floor(Math.random() * sides) + 1);
    }

    const rawTotal = rolls.reduce((sum, r) => sum + r, 0);
    const total = rawTotal + modifier;

    let formula = `${count}d${sides}`;
    if (modifier > 0) formula += `+${modifier}`;
    else if (modifier < 0) formula += `${modifier}`;

    // Return whatever the LLM needs to build its response.
    // Keep it flat and readable -- the LLM parses this JSON.
    return {
      success: true,
      data: {
        formula,
        rolls,
        total,
        rolledBy: context.senderId,
        isGroupRoll: context.isGroup,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Tool 2: random_pick
// Shows: required params, array type, input sanitization
// ---------------------------------------------------------------------------

const randomPick = {
  name: "random_pick",
  description:
    "Randomly pick one item from a list of choices. Use for decisions, assignments, or draws.",
  category: "action",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      choices: {
        type: "array",
        items: { type: "string" },
        minItems: 2,
        description: "List of options to choose from (minimum 2)",
      },
    },
    // "required" makes the LLM always provide this param.
    required: ["choices"],
  },

  execute: async (params, context) => {
    const { choices } = params;

    if (!Array.isArray(choices) || choices.length < 2) {
      return { success: false, error: "choices must be an array with at least 2 items" };
    }

    const valid = choices.filter((c) => typeof c === "string" && c.trim().length > 0);
    if (valid.length < 2) {
      return { success: false, error: "Need at least 2 non-empty choices" };
    }

    const picked = valid[Math.floor(Math.random() * valid.length)];

    return {
      success: true,
      data: {
        picked,
        totalChoices: valid.length,
        chatId: context.chatId,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Export -- Teleton picks up everything in this array.
// One plugin can export as many tools as needed.
// ---------------------------------------------------------------------------

export const tools = [diceRoll, randomPick];
