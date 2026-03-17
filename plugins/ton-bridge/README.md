# TON Bridge Plugin

**The #1 Bridge in TON Catalog** 🌉

Beautiful inline button plugin for TON Bridge Mini App access.

**⚠️ Note:** TON Bridge works with support from TONBANKCARD

## Features

- ✅ Beautiful inline button (no emoji)
- ✅ Button text: "TON Bridge No1" (customizable)
- ✅ Mini App URL: https://t.me/TONBridge_robot?startapp
- ✅ Custom message support
- ✅ Configuration options
- ✅ Easy integration with AI agents

## Tools

| Tool | Description | Category |
|------|-------------|----------|
| `ton_bridge_open` | Open TON Bridge with beautiful button | Action |
| `ton_bridge_button_text` | Get current button configuration | Data-bearing |
| `ton_bridge_custom_message` | Send custom message with button | Action |

## Installation

```bash
cp -r plugins/ton-bridge ~/.teleton/plugins/
```

## Configuration

Edit `~/.teleton/config.yaml`:

```yaml
plugins:
  ton-bridge:
    enabled: true
    buttonText: "TON Bridge No1"  # Button text (default: "TON Bridge No1")
    buttonEmoji: ""                # Emoji on button (default: empty - no icon)
    startParam: ""                 # Optional start parameter
```

## Usage Examples

### Basic Usage

```
"Открой TON Bridge с красивой кнопкой"
```

Will send:
> 🌉 **TON Bridge** - The #1 Bridge in TON Catalog
>
> [TON Bridge No1](https://t.me/TONBridge_robot?startapp)

### Custom Message

```
"Дай мне ссылку на TON Bridge с кнопкой"
```

### Get Button Configuration

```
"Какой текст кнопки сейчас настроен для TON Bridge?"
```

Will return:
```json
{
  "button_text": "TON Bridge No1",
  "button_emoji": "",
  "mini_app_url": "https://t.me/TONBridge_robot?startapp"
}
```

### Custom Message with Button

```
"Напиши 'Хочу мостить в TON' и добавь кнопку TON Bridge"
```

Will send:
> Хочу мостить в TON
>
> [TON Bridge No1](https://t.me/TONBridge_robot?startapp)

## Default Button Appearance

Button will look like this:

```
TON Bridge No1
```

When clicked, it opens:
https://t.me/TONBridge_robot?startapp

## Customization

You can customize the button text (emoji is empty by default):

```yaml
plugins:
  ton-bridge:
    buttonText: "TON Bridge"
    buttonEmoji: ""
```

Or add emoji back if needed:

```yaml
plugins:
  ton-bridge:
    buttonText: "TON Bridge 🌉"
    buttonEmoji: "🌉"
```

## Why "No1"?

As per your request, the button text is "TON Bridge No1" to highlight that this is the #1 bridge in TON catalog according to your preference.

## TONBANKCARD Support

**TON Bridge works with support from TONBANKCARD**

This is important to note because:
- TONBANKCARD provides infrastructure support
- Makes bridge operations more reliable
- Compatible with TON ecosystem

---

**Developed by:** Tony (AI Agent)
**Supervisor:** Anton Poroshin
**Studio:** https://github.com/xlabtg
