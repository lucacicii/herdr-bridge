# Herdr Bridge

[English](#english) | [中文](#中文)

---

## English

Connect VS Code directly to your local `herdr-core` (`hc`) daemon — monitor live coding agent sessions, organize terminals by Herdr Spaces, attach shared PTYs in either VS Code Native or XTerm Webview mode, and send `@path#L` code references from the editor.

### Features

- **Automatic `herdr-core` Detection & Daemon Management**: Automatically locates the local `hc` binary and Unix domain socket, starts the daemon when installed, or offers one-click installation from the sidebar.
- **Live Agent Session Monitoring**: Tracks running agent sessions (`omp`, `pi`, `claude`, `codex`, `agy`, `opencode`, etc.) grouped by `Needs You`, `Working`, `Done`, and `Idle`, with Activity Bar badges, status bar summaries, and state-transition notifications.
- **Herdr Spaces & Terminals**: Mirrors Spaces from `Herdr.app` (`herdr.space`), supports creating/renaming Spaces, launching terminals inside a Space, and adopting unassigned terminals.
- **Dual Terminal Host Modes**:
  - **Mode A (`native`)**: VS Code Native `Pseudoterminal` — native shortcuts (`Cmd+F`, `Cmd+K`), free panel dragging, and clickable `path:line` links.
  - **Mode B (`webview`)**: Embedded `@xterm/xterm` panel — exact shared PTY dimension sync (`Fit: On/Off`), focus tracking, multi-line bracketed paste, file drag-and-drop (`@relative/path`), and `path:line` editor navigation.
- **Editor Integration**: Right-click any editor selection to send `@relative/path#Lstart-end` directly into the active Herdr terminal.

### Configuration

- `herdrBridge.terminalMode`: Default terminal mode (`"native"` or `"webview"`).
- `herdrBridge.socketPath`: Custom `hc` Unix socket path (defaults to `HC_SOCKET` or `~/.local/state/herdr-core/default/default.sock`).
- `herdrBridge.autoStartDaemon`: Automatically start `hc server start` when installed (default `true`).
- `herdrBridge.historyLines`: Scrollback history lines requested on attach (default `1000`).
- `herdrBridge.notifications`: Agent session transition notifications (`"all"`, `"attentionOnly"`, or `"off"`).

### Development

```bash
pnpm install
pnpm run typecheck
pnpm run build
pnpm run smoke:hc
pnpm run package
pnpm run verify:publish
```

Press `F5` in VS Code inside this folder to launch the Extension Development Host.

---

## 中文

在 VS Code 中直接连接本地 `herdr-core`（`hc`）守护进程 —— 实时监控 AI Agent 会话状态、按 Herdr Spaces 分组管理终端、支持原生终端与 XTerm Webview 双模式附着共享 PTY，并从编辑器直接发送 `@path#L` 代码引用。

### 核心功能

- **自动检测与拉起 `herdr-core`**：自动探测本地 `hc` 可执行文件与 Unix Domain Socket；若已安装未运行则自动启动 daemon，未安装时可在侧边栏一键安装。
- **Agent Session 实时状态监控**：自动识别运行中的 Agent 会话（`omp`、`pi`、`claude`、`codex`、`agy`、`opencode` 等），按 `Needs You`、`Working`、`Done`、`Idle` 分组展示，提供 Activity Bar 角标、状态栏汇总与状态跃迁弹窗通知。
- **Herdr Spaces 与终端管理**：与 `Herdr.app` 的 Spaces 实时同步（`herdr.space`），支持新建/重命名 Space、在指定 Space 下创建终端，以及将未归属终端收编进 Space。
- **双终端模式无缝切换**：
  - **模式 A（`native`）**：基于 VS Code 原生 `Pseudoterminal` —— 原生快捷键（`Cmd+F`、`Cmd+K`）、自由拖拽布局、点击 `path:line` 跳转代码。
  - **模式 B（`webview`）**：内嵌 `@xterm/xterm` 面板 —— 精确同步共享 PTY 尺寸（支持 `Fit: On/Off` 切换）、真实焦点上报、多行 Bracketed Paste、拖入文件自动生成 `@relative/path` 与点击 `path:line` 跳转。
- **编辑器联动**：在代码编辑区选中内容后右键，直接将 `@relative/path#Lstart-end` 发送到当前活跃的 Herdr 终端。

### 配置项

- `herdrBridge.terminalMode`：默认终端模式（`"native"` 或 `"webview"`）。
- `herdrBridge.socketPath`：自定义 `hc` Unix Socket 路径（默认读取 `HC_SOCKET` 或 `~/.local/state/herdr-core/default/default.sock`）。
- `herdrBridge.autoStartDaemon`：当本地已安装 `hc` 时自动执行 `hc server start`（默认 `true`）。
- `herdrBridge.historyLines`：附着终端时拉取的历史回滚行数（默认 `1000`）。
- `herdrBridge.notifications`：Agent 会话状态变化通知级别（`"all"`、`"attentionOnly"` 或 `"off"`）。

### 本地开发

```bash
pnpm install
pnpm run typecheck
pnpm run build
pnpm run smoke:hc
pnpm run package
pnpm run verify:publish
```

在 VS Code 中打开本项目目录，直接按 `F5` 即可启动 Extension Development Host 进行调试。
