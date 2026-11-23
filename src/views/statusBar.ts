import * as vscode from 'vscode';
import type { HerdrHub } from '../hub/herdrHub';
import type { TerminalManager } from '../terminal/manager';

export class HerdrStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly sub: vscode.Disposable;

  constructor(
    private readonly hub: HerdrHub,
    private readonly terminals: TerminalManager
  ) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.item.command = 'herdrBridge.switchMode';
    this.sub = this.hub.onDidChange(() => this.update());
    this.update();
    this.item.show();
  }

  update(): void {
    const state = this.hub.getConnectionState();
    const modeLabel = this.terminals.getPreferredMode() === 'webview' ? 'XTerm' : 'Native';
    const count = this.hub.getTerminals().length;
    const blocked = this.hub.getBlockedCount();

    if (state === 'connecting') {
      this.item.text = `$(sync~spin) Herdr: Connecting (${modeLabel})`;
      this.item.backgroundColor = undefined;
      this.item.tooltip = 'Connecting to herdr-core (hc)... Click to switch terminal mode.';
      return;
    }

    if (state === 'connected') {
      const summary = this.hub.getSessionSummary();
      const parts: string[] = [];
      if (summary.needsYou > 0) {
        parts.push(`$(bell-dot) ${summary.needsYou}`);
      }
      if (summary.working > 0) {
        parts.push(`$(sync~spin) ${summary.working}`);
      }
      if (summary.done > 0) {
        parts.push(`$(pass) ${summary.done}`);
      }
      const sessionBadge = parts.length > 0 ? ` · ${parts.join(' ')}` : '';
      this.item.text = `$(terminal) Herdr: ${count}${sessionBadge} [${modeLabel}]`;
      this.item.backgroundColor =
        summary.needsYou > 0
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined;
      this.item.tooltip = [
        `Connected to ${this.hub.client.getSocketPath()}`,
        `Terminals: ${count} · Sessions: ${summary.total} (needs you: ${summary.needsYou}, working: ${summary.working}, done: ${summary.done}, idle: ${summary.idle})`,
        'Click to switch default terminal mode (Native / XTerm Webview).',
      ].join('\n');
      return;
    }

    const env = this.hub.getEnvStatus();
    if (env && !env.hcCli.installed) {
      this.item.text = '$(cloud-download) Herdr: hc not installed';
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this.item.tooltip = 'herdr-core (hc) CLI not found. Open Herdr Bridge sidebar to install.';
    } else {
      this.item.text = `$(debug-disconnect) Herdr: Offline [${modeLabel}]`;
      this.item.backgroundColor = undefined;
      this.item.tooltip = `herdr-core daemon is not running at ${this.hub.client.getSocketPath()}`;
    }
  }

  dispose(): void {
    this.sub.dispose();
    this.item.dispose();
  }
}
