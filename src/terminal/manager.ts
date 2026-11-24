import * as vscode from 'vscode';
import type { HcTerminal } from '../hc/types';
import type { HerdrHub } from '../hub/herdrHub';
import { NativeTerminalHandle, registerNativeTerminalLinkProvider } from './nativeTerminal';
import type { HerdrTerminalHandle, TerminalMode } from './types';
import { WebviewTerminalHandle } from './webviewTerminal';

const PERSISTED_NATIVE_TERMINALS_KEY = 'herdrBridge.openNativeTerminals.v1';

interface PersistedNativeTerminals {
  terminals: string[];
  activeTerminalId?: string;
}

export class TerminalManager implements vscode.Disposable {
  private readonly handles = new Map<string, HerdrTerminalHandle>();
  private readonly nativeRegistry = new WeakMap<vscode.Terminal, NativeTerminalHandle>();
  private readonly disposables: vscode.Disposable[] = [];
  private activeTerminalId: string | undefined;
  private isDisposing = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly hub: HerdrHub,
    private readonly workspaceState?: vscode.Memento
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
          this.persistNativeTerminals();
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

  private persistNativeTerminals(): void {
    if (!this.workspaceState || this.isDisposing) {
      return;
    }
    const terminals = Array.from(this.handles.values())
      .filter((h) => h.mode === 'native')
      .map((h) => h.terminalId);
    const active =
      this.activeTerminalId && terminals.includes(this.activeTerminalId)
        ? this.activeTerminalId
        : undefined;
    void this.workspaceState.update(PERSISTED_NATIVE_TERMINALS_KEY, {
      terminals,
      activeTerminalId: active,
    } satisfies PersistedNativeTerminals);
  }

  async openTerminal(
    terminalId: string,
    modeOverride?: TerminalMode,
    options?: { preserveFocus?: boolean }
  ): Promise<HerdrTerminalHandle> {
    const targetMode = modeOverride ?? this.getPreferredMode();
    const existing = this.handles.get(terminalId);

    if (existing) {
      if (existing.mode === targetMode) {
        this.activeTerminalId = terminalId;
        existing.reveal(options?.preserveFocus);
        this.persistNativeTerminals();
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
    this.persistNativeTerminals();

    handle.onDidDispose(() => {
      if (this.handles.get(terminalId) === handle) {
        this.handles.delete(terminalId);
      }
      if (this.activeTerminalId === terminalId) {
        this.activeTerminalId = undefined;
      }
      this.persistNativeTerminals();
    });

    handle.reveal(options?.preserveFocus);
    return handle;
  }

  async reviveWebviewPanel(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
    const rawId = (state as { terminalId?: unknown } | undefined)?.terminalId;
    const terminalId = typeof rawId === 'string' && rawId ? rawId : undefined;
    if (!terminalId || this.handles.has(terminalId)) {
      panel.dispose();
      return;
    }

    let termInfo: HcTerminal | undefined = this.hub.getTerminalById(terminalId);
    if (!termInfo) {
      termInfo = await this.hub.client.getTerminal(terminalId).catch(() => undefined);
    }
    if (!termInfo) {
      panel.dispose();
      return;
    }

    const handle = new WebviewTerminalHandle(
      this.extensionUri,
      this.hub.client,
      termInfo,
      this.getHistoryLines(),
      (id) => {
        void this.openTerminal(id, 'native');
      },
      (id) => {
        this.activeTerminalId = id;
      },
      panel
    );

    this.handles.set(terminalId, handle);
    if (panel.active) {
      this.activeTerminalId = terminalId;
    }

    handle.onDidDispose(() => {
      if (this.handles.get(terminalId) === handle) {
        this.handles.delete(terminalId);
      }
      if (this.activeTerminalId === terminalId) {
        this.activeTerminalId = undefined;
      }
    });
  }

  async restoreNativeTerminals(): Promise<void> {
    const saved = this.workspaceState?.get<PersistedNativeTerminals>(PERSISTED_NATIVE_TERMINALS_KEY);
    if (!saved?.terminals?.length || this.isDisposing) {
      return;
    }

    const uniqueIds = Array.from(new Set(saved.terminals));
    for (const id of uniqueIds) {
      if (this.isDisposing || this.handles.has(id)) {
        continue;
      }
      const termInfo = this.hub.getTerminalById(id);
      if (!termInfo) {
        continue;
      }
      await this.openTerminal(id, 'native', {
        preserveFocus: id !== saved.activeTerminalId,
      }).catch(() => undefined);
    }

    if (saved.activeTerminalId && this.handles.has(saved.activeTerminalId)) {
      this.activeTerminalId = saved.activeTerminalId;
      this.handles.get(saved.activeTerminalId)?.reveal(false);
    }
    this.persistNativeTerminals();
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

  closeTerminal(terminalId: string): void {
    const openHandle = this.handles.get(terminalId);
    if (!openHandle) {
      return;
    }
    this.handles.delete(terminalId);
    if (this.activeTerminalId === terminalId) {
      this.activeTerminalId = undefined;
    }
    this.persistNativeTerminals();
    openHandle.dispose();
  }

  dispose(): void {
    this.isDisposing = true;
    for (const handle of this.handles.values()) {
      handle.dispose();
    }
    this.handles.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
