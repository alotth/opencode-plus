---
title: Plugin Webview Bridge
description: Generic webview UI contributions and secure file bridge
---

## Overview

OpenCode now supports plugin-driven session UI with two config entries:

- `ui.session.tabs`
- `ui.session.buttons`

Tabs are resolved in `packages/app/src/utils/plugin-ui.ts` and rendered in `packages/app/src/pages/session/session-side-panel.tsx`. Buttons are rendered in `packages/app/src/components/session/session-header.tsx`.

This removes task-specific app code and lets any plugin add session webviews through a shared model.

## End-to-end flow

1. A plugin `config` hook pushes a tab and button definition.
2. The app validates and normalizes tab/button config (`id`, `title`, `src`, `origins`, `permissions`).
3. The session header renders matching buttons.
4. Clicking a button opens `web:<id>` and mounts an iframe.
5. On iframe load, host sends a per-tab bridge token.
6. Webview requests `file.read` or `file.write` via postMessage.
7. Host enforces origin, token, path scopes, and hash checks.

## Bridge contract

Host handshake:

```json
{
  "type": "opencode.bridge.host",
  "tab": "web:example",
  "token": "3b5f..."
}
```

Read request:

```json
{
  "type": "opencode.bridge.request",
  "requestId": "req-1",
  "action": "file.read",
  "token": "3b5f...",
  "payload": {
    "path": "TASKS.md"
  }
}
```

Read response:

```json
{
  "type": "opencode.bridge.response",
  "requestId": "req-1",
  "ok": true,
  "payload": {
    "path": "TASKS.md",
    "content": "# ...",
    "hash": "9d2a..."
  }
}
```

Write request (optimistic concurrency):

```json
{
  "type": "opencode.bridge.request",
  "requestId": "req-2",
  "action": "file.write",
  "token": "3b5f...",
  "payload": {
    "path": "TASKS.md",
    "content": "# updated content",
    "expectedHash": "9d2a..."
  }
}
```

Conflict response:

```json
{
  "type": "opencode.bridge.response",
  "requestId": "req-2",
  "ok": false,
  "error": "Hash mismatch. File changed since last read.",
  "payload": {
    "path": "TASKS.md",
    "hash": "2c1e..."
  }
}
```

## Security model

- Host validates iframe `origin` against `tab.origins` (`*` supported).
- Each tab gets a unique token, required on every request.
- Paths are normalized against workspace root and cannot escape with traversal.
- Access is gated by scopes:
  - `permissions.file.read`
  - `permissions.file.write`
- `file.write` requires `expectedHash`; writes fail on stale reads.

## Generic plugin config example

```js
input.ui.session.tabs.push({
  id: "kanban-roadmap",
  title: "Tasks",
  src: "/global/plugin/kanban-roadmap/index.html?tasksFile=TASKS.md",
  origins: ["*"],
  permissions: {
    file: {
      read: ["TASKS.md", "tasks/**/*.md"],
      write: ["TASKS.md", "tasks/**/*.md"],
    },
  },
})

input.ui.session.buttons.push({
  id: "kanban-roadmap",
  label: "Tasks",
  tab: "kanban-roadmap",
})
```

## Asset serving

Global plugin assets are served by:

- `GET /global/plugin/:name/:asset{.+}`
- implemented in `packages/opencode/src/server/routes/global.ts`

For example, this path maps to plugin assets:

- `/global/plugin/kanban-roadmap/index.html`

## Troubleshooting

- Button missing: ensure button `tab` points to an existing tab `id`.
- Tab missing: ensure `id`, `title`, and `src` are valid and unique.
- Bridge denied: verify `origin`, token, and allowed action.
- Read denied: verify normalized path matches `read` scopes.
- Write denied: verify `write` scopes and `expectedHash` are provided.
- Hash mismatch: re-read, merge, retry write with latest hash.
