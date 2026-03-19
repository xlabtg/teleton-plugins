# TON Bridge

Share the TON Bridge Mini App link with an inline button in Telegram chats.
Works in DMs, groups, and channels.

TON Bridge works with support from TONBANKCARD.

## Features

- Sends a message with a URL inline button directly to the current chat
- Button text controllable per tool call (the LLM can omit or include emoji)
- Customizable default button text via config
- Custom message support

## Tools

| Tool | Description | Category |
|------|-------------|----------|
| `ton_bridge_open` | Send a message with a TON Bridge Mini App button | action |
| `ton_bridge_about` | Send info about TON Bridge with a Mini App button | data-bearing |
| `ton_bridge_custom_message` | Send a custom message alongside a TON Bridge button | action |

## Installation

```bash
mkdir -p ~/.teleton/plugins
cp -r plugins/ton-bridge ~/.teleton/plugins/
```

## Configuration

```yaml
# ~/.teleton/config.yaml
plugins:
  ton_bridge:
    buttonText: "TON Bridge No1"  # Default button label (default: "TON Bridge No1")
    startParam: ""                 # Optional start parameter appended to the Mini App URL
```

> **Note:** Emoji on the button is controlled by the agent at call time via the `buttonText` parameter, not by config. This allows the agent to send buttons with or without emoji as requested by the user.

## Usage Examples

### Open TON Bridge
```
Open TON Bridge
```

Sends a message with a button linking to `https://t.me/TONBridge_robot?startapp`.

### Open TON Bridge without emoji on button
```
Open TON Bridge, no emoji on the button
```

The agent will call `ton_bridge_open` with `buttonText: "TON Bridge No1"` (no emoji).

### Get Info About TON Bridge
```
Tell me about TON Bridge
```

### Custom Message with Button
```
Send "Transfer your assets via TON Bridge" with a TON Bridge button
```

## Tool Schemas

### `ton_bridge_open`

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `message` | string | No | — | Optional message text to show with the button |
| `buttonText` | string | No | config default | Button label. Do not include emoji unless user requested it. |

### `ton_bridge_about`

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `buttonText` | string | No | config default | Button label. Do not include emoji unless user requested it. |

### `ton_bridge_custom_message`

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `customMessage` | string | Yes | — | Custom message text to display with the button |
| `buttonText` | string | No | config default | Button label. Do not include emoji unless user requested it. |

---

**Developer:** [xlabtg](https://github.com/xlabtg)
