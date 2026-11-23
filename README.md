# Herdr Bridge

Connect VS Code directly to your local [`herdr-core`](https://github.com/herdr-dev) (`hc`) daemon — monitor live coding agent sessions, organize terminals by Herdr Spaces, attach shared PTYs in either VS Code Native or XTerm Webview mode, and send `@path#L` code references from the editor.

## Features

- **Automatic `herdr-core` Detection & Daemon Management**: Automatically locates the local `hc` binary and Unix domain socket, starts the daemon when installed, or offers one-click installation from the sidebar.
- **Live Agent Session Monitoring**: Tracks running agent sessions (`omp`, `pi`, `claude`, `codex`, `agy`, `opencode`, etc.) grouped by `Needs You`, `Working`, `Done`, and `Idle`, with Activity Bar badges, status bar summaries, and state-transition notifications.
- **Herdr Spaces & Terminals**: Mirrors Spaces from `Herdr.app` (`herdr.space`), supports creating/renaming Spaces, launching terminals inside a Space, and adopting unassigned terminals.
- **Dual Terminal Host Modes**:
  - **Mode A (`native`)**: VS Code Native `Pseudoterminal` — native shortcuts (`Cmd+F`, `Cmd+K`), free panel dragging, and clickable `path:line` links.
  - **Mode B (`webview`)**: Embedded `@xterm/xterm` panel — exact shared PTY dimension sync (`Fit: On/Off`), focus tracking, multi-line bracketed paste, file drag-and-drop (`@relative/path`), and `path:line` editor navigation.
- **Editor Integration**: Right-click any editor selection to send `@relative/path#Lstart-end` directly into the active Herdr terminal.

## Configuration

- `herdrBridge.terminalMode`: Default terminal mode (`"native"` or `"webview"`).
- `herdrBridge.socketPath`: Custom `hc` Unix socket path (defaults to `HC_SOCKET` or `~/.local/state/herdr-core/default/default.sock`).
- `herdrBridge.autoStartDaemon`: Automatically start `hc server start` when installed (default `true`).
- `herdrBridge.historyLines`: Scrollback history lines requested on attach (default `1000`).
- `herdrBridge.notifications`: Agent session transition notifications (`"all"`, `"attentionOnly"`, or `"off"`).

## Development

```bash
pnpm install
pnpm run typecheck
pnpm run build
pnpm run smoke:hc
pnpm run package
pnpm run verify:publish
```

Press `F5` in VS Code inside this folder to launch the Extension Development Host.
