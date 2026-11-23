import * as vscode from 'vscode';
import type { HerdrHub } from '../hub/herdrHub';
import { NativeTerminalHandle, registerNativeTerminalLinkProvider } from './nativeTerminal';
import type { HerdrTerminalHandle, TerminalMode } from './types';
import { WebviewTerminalHandle } from './webviewTerminal';

export class TerminalManager implements vscode.Disposable {
  private readonly handles = new Map<string, HerdrTerminalHandle>();
  private readonly nativeRegistry = new WeakMap<vscode.Terminal, NativeTerminalHandle>();
  private readonly disposables: vscode.Disposable[] = [];
  private activeTerminalId: string | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly hub: HerdrHub
  ) {
    this.disposables.push(registerNativeTerminalLinkProvider(this.nativeRegistry));

    this.disposables.push(
      vscode.window.onDidChangeActiveTerminal((term) => {
        if (!term) {
          return;
        }
        const handle = this.nativeRegistry.get(term);
        if (handle) {
          this.activeTerminalId = handle.terminalId;
        }
      })
    );
  }

  getPreferredMode(): TerminalMode {
    const mode = vscode.workspace
      .getConfiguration('herdrBridge')
      .get<string>('terminalMode', 'native');
    return mode === 'webview' ? 'webview' : 'native';
  }

  private getHistoryLines(): number {
    return vscode.workspace.getConfiguration('herdrBridge').get<number>('historyLines', 1000);
  }

  getActiveTerminalId(): string | undefined {
    if (this.activeTerminalId && this.handles.has(this.activeTerminalId)) {
      return this.activeTerminalId;
    }
    const first = this.handles.keys().next();
    return first.done ? undefined : first.value;
  }

  getOpenHandles(): HerdrTerminalHandle[] {
    return Array.from(this.handles.values());
  }

  async openTerminal(terminalId: string, modeOverride?: TerminalMode): Promise<HerdrTerminalHandle> {
    const targetMode = modeOverride ?? this.getPreferredMode();
    const existing = this.handles.get(terminalId);

    if (existing) {
      if (existing.mode === targetMode) {
        this.activeTerminalId = terminalId;
        existing.reveal();
        return existing;
      }
      // Close existing handle when explicitly switching between Mode A and Mode B.
      existing.dispose();
      this.handles.delete(terminalId);
    }

    let termInfo = this.hub.getTerminalById(terminalId);
    if (!termInfo) {
      termInfo = await this.hub.client.getTerminal(terminalId);
    }

    const historyLines = this.getHistoryLines();
    let handle: HerdrTerminalHandle;

    if (targetMode === 'webview') {
      handle = new WebviewTerminalHandle(
        this.extensionUri,
        this.hub.client,
        termInfo,
        historyLines,
        (id) => {
          void this.openTerminal(id, 'native');
        },
        (id) => {
          this.activeTerminalId = id;
        }
      );
    } else {
      handle = new NativeTerminalHandle(
        this.hub.client,
        termInfo,
        historyLines,
        this.nativeRegistry
      );
    }

    this.handles.set(terminalId, handle);
    this.activeTerminalId = terminalId;

    handle.onDidDispose(() => {
      if (this.handles.get(terminalId) === handle) {
        this.handles.delete(terminalId);
      }
      if (this.activeTerminalId === terminalId) {
        this.activeTerminalId = undefined;
      }
    });

    handle.reveal();
    return handle;
  }

  async sendTextToTerminal(terminalId: string, text: string): Promise<void> {
    const openHandle = this.handles.get(terminalId);
    if (openHandle) {
      openHandle.sendText(text, true);
      openHandle.reveal();
      return;
    }
    await this.hub.client.sendText(terminalId, text);
  }

  dispose(): void {
    for (const handle of this.handles.values()) {
      handle.dispose();
    }
    this.handles.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
