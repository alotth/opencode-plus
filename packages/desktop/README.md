# OpenCode Desktop

Native OpenCode desktop app, built with Tauri v2.

## Prerequisites

Building the desktop app requires additional Tauri dependencies (Rust toolchain, platform-specific libraries). See the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for setup instructions.

## Development

From the repo root:

```bash
bun install
bun run --cwd packages/desktop tauri dev
```

## Build

```bash
bun run --cwd packages/desktop tauri build
```

## Troubleshooting

### Rust compiler not found

If you see errors about Rust not being found, install it via [rustup](https://rustup.rs/):

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

### Desktop stays on infinite loading in dev (macOS/Linux)

If the desktop app stays on loading, the sidecar process might be blocked by your interactive shell startup.

Run desktop dev with a minimal shell:

```bash
SHELL=/bin/sh RUST_LOG=opencode_lib=debug bun run dev:desktop
```

Why this helps: `SHELL=/bin/sh` avoids heavy or blocking shell init hooks (for example from `~/.zshrc`, `~/.bashrc`, or shell plugins), so the sidecar can start normally.
