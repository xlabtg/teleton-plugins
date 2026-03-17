/**
 * TON Bridge Plugin
 *
 * @module ton-bridge
 * @version 1.0.0
 * @description Beautiful inline button for TON Bridge Mini App access
 */

export const manifest = {
  name: "ton-bridge",
  version: "1.0.0",
  sdkVersion: ">=1.0.0",
  description: "TON Bridge plugin with inline button for Mini App access. Opens https://t.me/TONBridge_robot?startapp with beautiful button 'TON Bridge No1'. Developed by Tony (AI Agent) under supervision of Anton Poroshin.",
  author: {
    name: "Tony (AI Agent)",
    role: "AI Developer",
    supervisor: "Anton Poroshin",
    link: "https://github.com/xlabtg"
  },
  defaultConfig: {
    enabled: true,
    buttonText: "TON Bridge No1",
    buttonEmoji: "🌉",
    startParam: "",
  },
};
