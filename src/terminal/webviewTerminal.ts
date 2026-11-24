import * as crypto from 'node:crypto';
import { TextDecoder } from 'node:util';
import * as vscode from 'vscode';
import type { HcAttachStream, HcClient } from '../hc/client';
import type { HcTerminal } from '../hc/types';
import { formatUriAsReference, openResolvedFile } from './linkResolver';
import { formatTerminalDisplayName, type HerdrTerminalHandle } from './types';

type WebviewInboundMessage =
  | { type: 'ready'; cols: number; rows: number }
  | { type: 'input'; data: string }
  | { type: 'paste'; text: string; bracketed?: boolean }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'focus'; focused: boolean }
  | { type: 'interrupt' }
  | { type: 'openLink'; filePath: string; line: number; column: number }
  | { type: 'dropUris'; uriList: string }
  | { type: 'switchMode' };

export class WebviewTerminalHandle implements HerdrTerminalHandle {
  readonly mode = 'webview' as const;
  readonly terminalId: string;
  readonly panel: vscode.WebviewPanel;

  private readonly disposeEmitter = new vscode.EventEmitter<void>();
  private readonly decoder = new TextDecoder('utf-8');
  private stream: HcAttachStream | undefined;
  private pendingOutput = '';
  private flushTimer: NodeJS.Timeout | undefined;
  private webviewReady = false;
  private disposed = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly client: HcClient,
    private readonly termInfo: HcTerminal,
    private readonly historyLines: number,
    private readonly onSwitchToNative: (terminalId: string) => void,
    private readonly onBecameActive: (terminalId: string) => void,
    existingPanel?: vscode.WebviewPanel
  ) {
    this.terminalId = termInfo.address;

    const webviewOptions = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')],
    };

    if (existingPanel) {
      this.panel = existingPanel;
      this.panel.title = `Herdr: ${formatTerminalDisplayName(termInfo)}`;
      this.panel.webview.options = webviewOptions;
    } else {
      this.panel = vscode.window.createWebviewPanel(
        'herdrBridge.xtermTerminal',
        `Herdr: ${formatTerminalDisplayName(termInfo)}`,
        vscode.ViewColumn.Beside,
        {
          ...webviewOptions,
          retainContextWhenHidden: true,
        }
      );
    }

    this.panel.iconPath = new vscode.ThemeIcon('terminal');
    this.panel.webview.html = this.buildHtml(this.panel.webview);

    this.panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) {
        this.onBecameActive(this.terminalId);
      }
      this.stream?.focus(e.webviewPanel.active);
    });

    this.panel.onDidDispose(() => {
      this.cleanup();
      this.fireDisposed();
    });

    this.panel.webview.onDidReceiveMessage((msg: WebviewInboundMessage) => {
      void this.handleWebviewMessage(msg);
    });
  }

  private async handleWebviewMessage(msg: WebviewInboundMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.webviewReady = true;
        await this.attach(msg.cols, msg.rows);
        break;
      case 'input':
        this.stream?.writeData(msg.data);
        break;
      case 'paste':
        if (msg.text) {
          const payload = msg.bracketed ? `\x1b[200~${msg.text}\x1b[201~` : msg.text;
          this.stream?.writeData(payload);
        }
        break;
      case 'resize':
        this.stream?.resize(msg.cols, msg.rows);
        break;
      case 'focus':
        if (msg.focused) {
          this.onBecameActive(this.terminalId);
        }
        this.stream?.focus(msg.focused);
        break;
      case 'interrupt':
        try {
          await this.client.interruptTerminal(this.terminalId);
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Failed to interrupt ${this.terminalId}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        break;
      case 'openLink': {
        const opened = await openResolvedFile(
          msg.filePath,
          msg.line,
          msg.column,
          this.termInfo.cwd
        );
        if (!opened) {
          void vscode.window.showWarningMessage(`File not found: ${msg.filePath}`);
        }
        break;
      }
      case 'dropUris': {
        const lines = msg.uriList
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#'));
        if (lines.length === 0) {
          break;
        }
        const refs = lines.map((raw) => {
          try {
            return formatUriAsReference(vscode.Uri.parse(raw), this.termInfo.cwd);
          } catch {
            return raw;
          }
        });
        this.stream?.writeData(refs.join(' ') + ' ');
        break;
      }
      case 'switchMode':
        this.onSwitchToNative(this.terminalId);
        break;
    }
  }

  private async attach(cols: number, rows: number): Promise<void> {
    if (this.disposed || this.stream) {
      return;
    }

    const reqCols = cols > 0 ? cols : this.termInfo.cols || 120;
    const reqRows = rows > 0 ? rows : this.termInfo.rows || 36;

    try {
      const stream = await this.client.attach({
        terminal: this.terminalId,
        cols: reqCols,
        rows: reqRows,
        history: this.historyLines,
        resize_notifications: true,
      });

      if (this.disposed) {
        stream.close();
        return;
      }

      this.stream = stream;
      void this.panel.webview.postMessage({
        type: 'ready',
        address: stream.meta.terminal.address,
        title: formatTerminalDisplayName(stream.meta.terminal),
        cols: stream.meta.terminal.cols,
        rows: stream.meta.terminal.rows,
        status: stream.meta.terminal.status?.state ?? 'idle',
      });

      stream.on('data', (chunk: Buffer) => {
        const text = this.decoder.decode(chunk, { stream: true });
        if (text) {
          this.enqueueOutput(text);
        }
      });

      stream.on('resize', ({ cols: nextCols, rows: nextRows }: { cols: number; rows: number }) => {
        void this.panel.webview.postMessage({
          type: 'resize',
          cols: nextCols,
          rows: nextRows,
        });
      });

      stream.on('close', (reason: string) => {
        const tail = this.decoder.decode();
        if (tail) {
          this.enqueueOutput(tail);
        }
        this.flushOutput();
        void this.panel.webview.postMessage({ type: 'closed', reason });
        this.stream = undefined;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void this.panel.webview.postMessage({ type: 'error', message });
    }
  }

  private enqueueOutput(text: string): void {
    this.pendingOutput += text;
    if (this.pendingOutput.length >= 16384) {
      this.flushOutput();
      return;
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        this.flushOutput();
      }, 8);
    }
  }

  private flushOutput(): void {
    if (!this.webviewReady || !this.pendingOutput || this.disposed) {
      return;
    }
    const data = this.pendingOutput;
    this.pendingOutput = '';
    void this.panel.webview.postMessage({ type: 'data', data });
  }

  reveal(preserveFocus = false): void {
    this.panel.reveal(vscode.ViewColumn.Beside, preserveFocus);
  }

  sendText(text: string, bracketed = true): void {
    if (!this.stream) {
      return;
    }
    if (bracketed && text.includes('\n')) {
      this.stream.writeData(`\x1b[200~${text}\x1b[201~`);
    } else {
      this.stream.writeData(text);
    }
  }

  onDidDispose(listener: () => void): vscode.Disposable {
    return this.disposeEmitter.event(listener);
  }

  private cleanup(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.stream) {
      this.stream.removeAllListeners();
      this.stream.close();
      this.stream = undefined;
    }
  }

  private fireDisposed(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.disposeEmitter.fire();
    this.disposeEmitter.dispose();
  }

  dispose(): void {
    this.cleanup();
    this.panel.dispose();
    this.fireDisposed();
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'terminal.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'terminal.css')
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:;" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Herdr XTerm</title>
  <style>
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: var(--vscode-terminal-background, var(--vscode-editor-background, #111));
      color: var(--vscode-foreground, #ccc);
      font-family: var(--vscode-font-family, sans-serif);
    }
    .root {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
    }
    .toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 4px 10px;
      border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
      background: var(--vscode-editorGroupHeader-tabsBackground, rgba(0,0,0,0.2));
      font-size: 12px;
      user-select: none;
    }
    .toolbar-left {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .badge {
      padding: 1px 6px;
      border-radius: 3px;
      background: var(--vscode-badge-background, #333);
      color: var(--vscode-badge-foreground, #fff);
      font-size: 11px;
      white-space: nowrap;
    }
    .title {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 500;
    }
    .dims {
      opacity: 0.7;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .toolbar-actions {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }
    button {
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.2));
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
      padding: 2px 8px;
      border-radius: 3px;
      font-size: 11px;
      cursor: pointer;
    }
    button:hover {
      background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.35));
    }
    button.active {
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
    }
    #terminal-container {
      flex: 1;
      min-height: 0;
      padding: 6px 8px;
      overflow: hidden;
    }
  </style>
</head>
<body data-terminal-id="${this.escapeHtml(this.terminalId)}">
  <div class="root">
    <div class="toolbar">
      <div class="toolbar-left">
        <span class="badge">XTerm Webview</span>
        <span id="term-title" class="title">${this.escapeHtml(formatTerminalDisplayName(this.termInfo))}</span>
        <span id="term-dims" class="dims">connecting...</span>
      </div>
      <div class="toolbar-actions">
        <button id="btn-fit" title="Toggle auto-fit to panel vs authoritative hc PTY dimensions">Fit: On</button>
        <button id="btn-ctrlc" title="Send interrupt (Ctrl+C)">Ctrl+C</button>
        <button id="btn-native" title="Reopen in VS Code Native Terminal (Mode A)">Switch to Native</button>
      </div>
    </div>
    <div id="terminal-container"></div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private escapeHtml(str: string): string {
    return str
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  }
}
