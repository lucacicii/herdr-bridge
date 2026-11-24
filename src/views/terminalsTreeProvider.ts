import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ArpSessionInfo } from '../commands/arpBridge';
import type { HcTerminal, HerdrSpace } from '../hc/types';
import type { HerdrHub } from '../hub/herdrHub';
import { formatTerminalDisplayName } from '../terminal/types';

function iconForTerminal(term: HcTerminal): vscode.ThemeIcon {
  const state = term.status?.state;
  switch (state) {
    case 'blocked':
      return new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('charts.orange'));
    case 'error':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
    case 'working':
      return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.blue'));
    case 'done':
      return new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green'));
    default:
      return new vscode.ThemeIcon('terminal');
  }
}

function iconForSpace(space: HerdrSpace): vscode.ThemeIcon {
  const hasBlocked = space.terminals.some(
    (t) => t.status?.state === 'blocked' || t.status?.state === 'error'
  );
  if (hasBlocked) {
    return new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('charts.orange'));
  }
  const hasWorking = space.terminals.some((t) => t.status?.state === 'working');
  if (hasWorking) {
    return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.blue'));
  }
  return new vscode.ThemeIcon('folder-library');
}

export class SpaceTreeItem extends vscode.TreeItem {
  constructor(readonly space: HerdrSpace) {
    super(
      space.name,
      space.terminals.length > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed
    );
    this.contextValue = 'herdrSpace';
    this.iconPath = iconForSpace(space);
    const folderName = space.folder ? path.basename(space.folder) : '';
    const count = `${space.terminals.length}`;
    this.description =
      folderName && folderName !== space.name ? `${count} · ${folderName}` : count;
    this.tooltip = [
      `Space: ${space.name}`,
      `ID: ${space.id}`,
      space.folder ? `Folder: ${space.folder}` : '',
      `Terminals: ${space.terminals.length}`,
    ]
      .filter(Boolean)
      .join('\n');
  }
}

export class UnassignedGroupItem extends vscode.TreeItem {
  constructor(readonly terminals: HcTerminal[]) {
    super('Unassigned Terminals', vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'herdrUnassignedGroup';
    this.iconPath = new vscode.ThemeIcon('inbox');
    this.description = `${terminals.length}`;
    this.tooltip = 'Live hc terminals not yet adopted into any Herdr space';
  }
}

export class TerminalTreeItem extends vscode.TreeItem {
  constructor(
    readonly terminal: HcTerminal,
    syncedSession?: ArpSessionInfo,
    spaceFolder?: string
  ) {
    super(
      formatTerminalDisplayName(terminal, syncedSession?.title),
      vscode.TreeItemCollapsibleState.None
    );
    this.contextValue = terminal.labels?.['herdr.space']
      ? 'herdrTerminal'
      : 'herdrTerminalUnassigned';
    this.iconPath = iconForTerminal(terminal);

    const status = terminal.status?.state || terminal.state;
    const effectiveCwd = terminal.foreground?.cwd || terminal.cwd;
    const folder = effectiveCwd ? path.basename(effectiveCwd) : '';
    const spaceBase = spaceFolder ? path.basename(spaceFolder) : '';
    const folderLabel = folder && folder !== spaceBase ? folder : !spaceBase ? folder : '';
    this.description = [status, folderLabel].filter(Boolean).join(' · ');

    const lines = [
      `Address: ${terminal.address}`,
      syncedSession ? `Session: [${syncedSession.provider}] ${syncedSession.title} (${syncedSession.id})` : '',
      `State: ${terminal.state} (${terminal.status?.state ?? 'idle'})`,
      terminal.foreground?.name ? `Process: ${terminal.foreground.name}` : '',
      effectiveCwd ? `CWD: ${effectiveCwd}` : '',
      terminal.status?.msg ? `Message: ${terminal.status.msg}` : '',
      `Size: ${terminal.cols}×${terminal.rows}`,
    ].filter(Boolean);
    this.tooltip = lines.join('\n');

    this.command = {
      command: 'herdrBridge.openTerminal',
      title: 'Open Terminal',
      arguments: [terminal.address],
    };
  }
}

export type HerdrTreeElement = SpaceTreeItem | UnassignedGroupItem | TerminalTreeItem;

export class TerminalsTreeProvider
  implements vscode.TreeDataProvider<HerdrTreeElement>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly sub: vscode.Disposable;

  constructor(
    private readonly hub: HerdrHub,
    private readonly resolveArpSession?: (term: HcTerminal) => ArpSessionInfo | undefined
  ) {
    this.sub = this.hub.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: HerdrTreeElement): vscode.TreeItem {
    return element;
  }

  getChildren(element?: HerdrTreeElement): HerdrTreeElement[] {
    if (!element) {
      const items: HerdrTreeElement[] = this.hub.getSpaces().map((sp) => new SpaceTreeItem(sp));
      const unassigned = this.hub.getUnassignedTerminals();
      if (unassigned.length > 0) {
        items.push(new UnassignedGroupItem(unassigned));
      }
      return items;
    }

    if (element instanceof SpaceTreeItem) {
      return element.space.terminals.map(
        (t) => new TerminalTreeItem(t, this.resolveArpSession?.(t), element.space.folder)
      );
    }

    if (element instanceof UnassignedGroupItem) {
      return element.terminals.map((t) => new TerminalTreeItem(t, this.resolveArpSession?.(t)));
    }

    return [];
  }

  dispose(): void {
    this.sub.dispose();
    this._onDidChangeTreeData.dispose();
  }
}
