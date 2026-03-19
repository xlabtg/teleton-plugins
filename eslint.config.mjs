// @ts-check
import js from "@eslint/js";

/** @type {import("eslint").Linter.Config[]} */
export default [
  js.configs.recommended,
  {
    files: ["plugins/**/*.js", "scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        // Node.js globals
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        // Web/Node globals available in Node 18+
        AbortSignal: "readonly",
        AbortController: "readonly",
        TextDecoder: "readonly",
        TextEncoder: "readonly",
        ReadableStream: "readonly",
        WritableStream: "readonly",
        TransformStream: "readonly",
        FormData: "readonly",
        Headers: "readonly",
        Request: "readonly",
        Response: "readonly",
        Blob: "readonly",
        File: "readonly",
        Event: "readonly",
        EventTarget: "readonly",
        MessageChannel: "readonly",
        MessageEvent: "readonly",
        crypto: "readonly",
        performance: "readonly",
        structuredClone: "readonly",
        queueMicrotask: "readonly",
        atob: "readonly",
        btoa: "readonly",
      },
    },
    rules: {
      // Errors — these indicate broken code
      "no-undef": "error",
      "no-console": "off",

      // Warnings — code quality issues, won't fail CI
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-var": "warn",
      "prefer-const": "warn",
    },
  },
  {
    // Ignore generated files and node_modules
    ignores: [
      "node_modules/**",
      "plugins/*/node_modules/**",
      "dist/**",
      "**/*.min.js",
    ],
  },
];
