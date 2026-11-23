import * as vscode from 'vscode';
import type { HerdrHub } from '../hub/herdrHub';
import type { TerminalManager } from '../terminal/manager';

class StatusItem extends vscode.TreeItem {
  constructor(
    label: string,
    description: string,
    iconId: string,
    command?: vscode.Command,
    tooltip?: string
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(iconId);
    this.command = command;
    this.tooltip = tooltip;
  }
}

export class StatusTreeProvider implements vscode.TreeDataProvider<StatusItem>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly sub: vscode.Disposable;

  constructor(
    private readonly hub: HerdrHub,
    private readonly terminals: TerminalManager
  ) {
    this.sub = this.hub.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: StatusItem): vscode.TreeItem {
    return element;
  }

  getChildren(): StatusItem[] {
    const env = this.hub.getEnvStatus();
    const mode = this.terminals.getPreferredMode();
    const modeLabel = mode === 'webview' ? 'XTerm Webview (Mode B)' : 'Native Terminal (Mode A)';

    if (!env) {
      return [new StatusItem('herdr-core', 'Checking...', 'sync~spin')];
    }

    const items: StatusItem[] = [];

    if (env.hcCli.installed) {
      items.push(
        new StatusItem(
          'hc CLI',
          env.hcCli.version || env.hcCli.path || 'Installed',
          'check',
          undefined,
          env.hcCli.path
        )
      );
    } else {
      items.push(
        new StatusItem(
          'hc CLI',
          'Not found (click to install)',
          'cloud-download',
          { command: 'herdrBridge.installCore', title: 'Install herdr-core (hc)' },
          'Click to install herdr-core (hc)'
        )
      );
    }

    if (env.daemon.running) {
      const ver = env.daemon.version ? `v${env.daemon.version}` : 'Running';
      const pid = env.daemon.pid ? `PID ${env.daemon.pid}` : '';
      items.push(
        new StatusItem(
          'Daemon',
          [ver, pid].filter(Boolean).join(' · '),
          'pass-filled',
          { command: 'herdrBridge.refresh', title: 'Refresh' },
          `Connected to ${env.daemon.socketPath}`
        )
      );
    } else if (env.hcCli.installed) {
      items.push(
        new StatusItem(
          'Daemon',
          'Stopped (click to start)',
          'play-circle',
          { command: 'herdrBridge.startDaemon', title: 'Start herdr-core Daemon' },
          env.daemon.error || 'Click to run hc server start'
        )
      );
    } else {
      items.push(
        new StatusItem(
          'Daemon',
          'Disconnected',
          'error',
          undefined,
          env.daemon.error
        )
      );
    }

    items.push(
      new StatusItem(
        'Socket',
        env.daemon.socketPath,
        'plug',
        undefined,
        env.daemon.socketPath
      )
    );

    items.push(
      new StatusItem(
        'herdr-app CLI',
        env.herdrApp?.installed ? 'Available' : 'Not found (Spaces read-only)',
        env.herdrApp?.installed ? 'check' : 'info',
        undefined,
        env.herdrApp?.path || 'Install Herdr.app to create, rename, or adopt Spaces'
      )
    );

    items.push(
      new StatusItem(
        'Terminal Mode',
        modeLabel,
        mode === 'webview' ? 'window' : 'terminal',
        { command: 'herdrBridge.switchMode', title: 'Switch Terminal Mode' },
        'Click to toggle between Mode A (Native Pseudoterminal) and Mode B (XTerm Webview)'
      )
    );

    return items;
  }

  dispose(): void {
    this.sub.dispose();
    this._onDidChangeTreeData.dispose();
  }
}
