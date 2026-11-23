# Herdr Bridge (VS Code Extension)

Zero-Go VS Code extension that detects and connects to your local `herdr-core` (`hc`) daemon over Unix Domain Socket in pure TypeScript, with dual terminal host modes side-by-side:

- **Mode A (`native`)**: VS Code Native `Pseudoterminal` (`vscode.window.createTerminal`) — native shortcuts (`Cmd+F`, `Cmd+K`), free panel dragging, and `path:line` link navigation.
- **Mode B (`webview`)**: Embedded `@xterm/xterm` `WebviewPanel` — authoritative shared PTY dimensions, real `FrameFocus` tracking, bracketed paste, `path:line` click-to-open, and drag-and-drop files formatted as `@relative/path`.

## Development

```bash
pnpm install
pnpm run typecheck
pnpm run build
pnpm run smoke:hc
```

Press `F5` in VS Code inside this folder to launch the Extension Development Host.
