# TON Bridge

Share the TON Bridge Mini App link with a beautiful inline button in Telegram chats.

TON Bridge works with support from TONBANKCARD.

## Features

- Inline button for TON Bridge Mini App access
- Customizable button text and emoji
- Custom message support
- Easy integration with AI agents

## Tools

| Tool | Description | Category |
|------|-------------|----------|
| `ton_bridge_open` | Send a message with a TON Bridge Mini App link | action |
| `ton_bridge_about` | Send info about TON Bridge with a link to the Mini App | data-bearing |
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
    buttonText: "TON Bridge No1"  # Button text (default: "TON Bridge No1")
    buttonEmoji: "🌉"             # Emoji on button (default: "🌉")
    startParam: ""                 # Optional start parameter
```

## Usage Examples

### Open TON Bridge
```
Open TON Bridge
```

Will send a message with a button linking to https://t.me/TONBridge_robot?startapp

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

### `ton_bridge_about`

No parameters required.

### `ton_bridge_custom_message`

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `customMessage` | string | Yes | — | Custom message text to display with the button |

---

**Developer:** [xlabtg](https://github.com/xlabtg)
