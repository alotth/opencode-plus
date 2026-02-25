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

Webviews communicate with the host via postMessage:

- host handshake: `opencode.bridge.host` (contains token)
- request: `opencode.bridge.request`
- response: `opencode.bridge.response`

Supported actions:

- `file.read`
- `file.write`

`file.write` uses optimistic concurrency with `expectedHash`.

## Where to read more

- Generic architecture and contract: `docs/plugin-webview-bridge.md`
- Kanban/Roadmap implementation notes: `temp/markdown-kanban-roadmap/README.opencode-dashboard.md`
