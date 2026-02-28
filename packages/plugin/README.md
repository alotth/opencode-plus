# Plugin Package

`@opencode-ai/plugin` is the runtime interface used by OpenCode plugins.

## Session UI contributions

Plugins can contribute session webviews through the `config` hook:

- `ui.session.tabs`
- `ui.session.buttons`

Minimal example:

```ts
import type { Plugin } from "@opencode-ai/plugin"

export const ExamplePlugin: Plugin = async () => {
  return {
    async config(input) {
      const cfg = input as typeof input & {
        ui?: {
          session?: {
            tabs?: Array<Record<string, unknown>>
            buttons?: Array<Record<string, unknown>>
          }
        }
      }

      cfg.ui ??= {}
      cfg.ui.session ??= {}
      cfg.ui.session.tabs ??= []
      cfg.ui.session.buttons ??= []

      cfg.ui.session.tabs.push({
        id: "example",
        title: "Example",
        src: "/global/plugin/example/index.html",
        origins: ["*"],
        permissions: {
          file: {
            read: ["README.md"],
            write: [],
          },
        },
      })

      cfg.ui.session.buttons.push({
        id: "example",
        label: "Example",
        tab: "example",
      })
    },
  }
}
```

## Bridge

Webviews communicate with the host through `postMessage` using a small request/response protocol.

- handshake from host: `opencode.bridge.host` (includes token)
- call from webview: `opencode.bridge.request`
- reply from host: `opencode.bridge.response`
- base actions: `file.read`, `file.write`

`file.write` supports optimistic concurrency with `expectedHash`.

Generic request shape:

```ts
window.parent.postMessage(
  {
    type: "opencode.bridge.request",
    id: "req-1",
    action: "file.read",
    payload: { path: "README.md" },
  },
  "*",
)
```

## Security model

Access is constrained by origin, token, allowed paths, and content hash checks.

- `origin`: webview origin must match an allowed origin
- `token`: each request must include the host-issued token
- `path scope`: file actions are limited to explicitly allowed path patterns
- `hash`: writes may require `expectedHash` to prevent stale updates

Generic protected write:

```ts
window.parent.postMessage(
  {
    type: "opencode.bridge.request",
    id: "req-2",
    action: "file.write",
    token: "<session-token>",
    payload: {
      path: "README.md",
      content: "next content",
      expectedHash: "<previous-hash>",
    },
  },
  "*",
)
```

## Serve assets

Plugin webview assets are served from a stable host route.

- route pattern: `/global/plugin/<plugin-id>/<asset-path>`
- use that route for `src` and linked static files
- keep plugin assets under your package and reference them by route

Generic config example:

```ts
{
  id: "panel",
  title: "Panel",
  src: "/global/plugin/<plugin-id>/index.html",
  origins: ["*"],
}
```
