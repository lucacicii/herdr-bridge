import { TextDecoder } from 'node:util';
import * as vscode from 'vscode';
import type { HcAttachStream, HcClient } from '../hc/client';
import type { HcTerminal } from '../hc/types';
import { findFileLinksInLine, openResolvedFile } from './linkResolver';
import { formatTerminalDisplayName, type HerdrTerminalHandle } from './types';

interface HerdrTerminalLink extends vscode.TerminalLink {
  filePath: string;
  line: number;
  column: number;
  cwd?: string;
}

export class NativeTerminalHandle implements HerdrTerminalHandle {
  readonly mode = 'native' as const;
  readonly terminalId: string;
  readonly terminal: vscode.Terminal;

  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number | void>();
  private readonly disposeEmitter = new vscode.EventEmitter<void>();
  private readonly decoder = new TextDecoder('utf-8');
  private stream: HcAttachStream | undefined;
  private pendingInput: string[] = [];
  private disposed = false;

  constructor(
    private readonly client: HcClient,
    private readonly termInfo: HcTerminal,
    private readonly historyLines: number,
    registry: WeakMap<vscode.Terminal, NativeTerminalHandle>
  ) {
    this.terminalId = termInfo.address;

    const pty: vscode.Pseudoterminal = {
      onDidWrite: this.writeEmitter.event,
      onDidClose: this.closeEmitter.event,
      open: (initialDimensions) => {
        void this.attach(initialDimensions);
      },
      close: () => {
        this.cleanupStream();
        this.fireDisposed();
      },
      handleInput: (data) => {
        if (this.stream) {
          this.stream.writeData(data);
        } else {
          this.pendingInput.push(data);
        }
      },
      setDimensions: (dimensions) => {
        this.stream?.resize(dimensions.columns, dimensions.rows);
      },
    };

    this.terminal = vscode.window.createTerminal({
      name: `Herdr: ${formatTerminalDisplayName(termInfo)}`,
      pty,
      iconPath: new vscode.ThemeIcon('terminal'),
      isTransient: true,
    });
    registry.set(this.terminal, this);
  }

  getCwd(): string {
    return this.termInfo.cwd;
  }

  setFocused(focused: boolean): void {
    this.stream?.focus(focused);
  }

  private async attach(dims?: vscode.TerminalDimensions): Promise<void> {
    if (this.disposed) {
      return;
    }
    const cols = dims?.columns && dims.columns > 0 ? dims.columns : this.termInfo.cols || 120;
    const rows = dims?.rows && dims.rows > 0 ? dims.rows : this.termInfo.rows || 36;

    try {
      const stream = await this.client.attach({
        terminal: this.terminalId,
        cols,
        rows,
        history: this.historyLines,
        resize_notifications: true,
      });

      if (this.disposed) {
        stream.close();
        return;
      }

      this.stream = stream;
      stream.focus(true);
      if (this.pendingInput.length > 0) {
        const queued = this.pendingInput.splice(0, this.pendingInput.length);
        for (const chunk of queued) {
          stream.writeData(chunk);
        }
      }

      stream.on('data', (chunk: Buffer) => {
        const text = this.decoder.decode(chunk, { stream: true });
        if (text) {
          this.writeEmitter.fire(text);
        }
      });

      stream.on('close', (reason: string) => {
        const tail = this.decoder.decode();
        if (tail) {
          this.writeEmitter.fire(tail);
        }
        this.writeEmitter.fire(`\r\n\x1b[90m[herdr-core detached: ${reason}]\x1b[0m\r\n`);
        this.stream = undefined;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.writeEmitter.fire(`\x1b[31m[herdr-core attach failed: ${message}]\x1b[0m\r\n`);
    }
  }

  reveal(preserveFocus = false): void {
    this.terminal.show(preserveFocus);
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

  private cleanupStream(): void {
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
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
    this.disposeEmitter.dispose();
  }

  dispose(): void {
    this.cleanupStream();
    this.terminal.dispose();
    this.fireDisposed();
  }
}

export function registerNativeTerminalLinkProvider(
  registry: WeakMap<vscode.Terminal, NativeTerminalHandle>
): vscode.Disposable {
  return vscode.window.registerTerminalLinkProvider({
    provideTerminalLinks(context) {
      const handle = registry.get(context.terminal);
      if (!handle) {
        return [];
      }
      return findFileLinksInLine(context.line).map((link) => {
        const item = new vscode.TerminalLink(
          link.startIndex,
          link.length,
          `Open ${link.filePath}:${link.line} in editor`
        ) as HerdrTerminalLink;
        item.filePath = link.filePath;
        item.line = link.line;
        item.column = link.column;
        item.cwd = handle.getCwd();
        return item;
      });
    },
    async handleTerminalLink(link) {
      const custom = link as HerdrTerminalLink;
      const opened = await openResolvedFile(custom.filePath, custom.line, custom.column, custom.cwd);
      if (!opened) {
        void vscode.window.showWarningMessage(`File not found: ${custom.filePath}`);
      }
    },
  });
}
