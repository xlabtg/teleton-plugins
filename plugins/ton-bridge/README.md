# TON Bridge

Share the TON Bridge Mini App link with an inline button in Telegram chats.
Works in DMs, groups, and channels.

TON Bridge works with support from TONBANKCARD.

## Tools

| Tool | Description | Category |
|------|-------------|----------|
| `ton_bridge_open` | Send a message with a TON Bridge Mini App button | action |
| `ton_bridge_about` | Send info about TON Bridge with a Mini App button | data-bearing |
| `ton_bridge_custom_message` | Send a custom message alongside a TON Bridge button | action |

## Install

```bash
mkdir -p ~/.teleton/plugins
cp -r plugins/ton-bridge ~/.teleton/plugins/
```

Restart Teleton — the plugin is auto-loaded from `~/.teleton/plugins/`. No changes to `config.yaml` are required.

## Usage examples

- "Open TON Bridge" → sends message with `[TON Bridge No1]` button
- "Open TON Bridge, emoji on the button" → sends message with `[🚀 TON Bridge]` button
- "Open TON Bridge, no emoji on the button" → sends message with `[TON Bridge]` button
- "Tell me about TON Bridge" → info message with inline button
- "Send a message about TON Bridge with a button" → custom message with inline button
- "Share a TON Bridge link with the text: Transfer your assets seamlessly" → custom text + inline button

Tool callers must pass `chatId` explicitly; these tools do not read the destination chat from runtime `context`.

## Configuration

Configuration is optional — the plugin works out of the box with defaults. Override in `config.yaml` only if needed:

```yaml
# ~/.teleton/config.yaml
plugins:
  ton_bridge:
    buttonText: "TON Bridge No1"  # Default button label (default: "TON Bridge No1")
    startParam: ""                 # Optional start parameter appended to the Mini App URL
```

> **Note:** Button emoji is controlled by the agent at call time via the `buttonText` parameter, not by config. This allows the agent to include or omit emoji as requested by the user.

## Tool schemas

### `ton_bridge_open`

Send a message with a TON Bridge Mini App button. Use when the user asks to open or access TON Bridge.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `chatId` | string | Yes | — | Telegram chat ID to send the message to |
| `message` | string | No | — | Optional message text to show with the button |
| `buttonText` | string | No | config default | Button label. Do not include emoji unless user requested it. |

### `ton_bridge_about`

Send an info message about TON Bridge with a Mini App button. Use when the user asks about TON Bridge.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `chatId` | string | Yes | — | Telegram chat ID to send the message to |
| `buttonText` | string | No | config default | Button label. Do not include emoji unless user requested it. |

### `ton_bridge_custom_message`

Send a custom message alongside a TON Bridge button.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `chatId` | string | Yes | — | Telegram chat ID to send the message to |
| `customMessage` | string | Yes | — | Custom message text to display with the button |
| `buttonText` | string | No | config default | Button label. Do not include emoji unless user requested it. |

---

**Developer:** [xlabtg](https://github.com/xlabtg)
