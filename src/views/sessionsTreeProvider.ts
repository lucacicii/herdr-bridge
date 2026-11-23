import * as path from 'node:path';
import * as vscode from 'vscode';
import type { HcTerminal } from '../hc/types';
import type { HerdrHub } from '../hub/herdrHub';
import {
  classifySessionBucket,
  detectAgentProgram,
  formatRelativeTime,
  type SessionBucket,
} from '../hub/sessionMonitor';

const BUCKET_META: Record<
  SessionBucket,
  { label: string; iconId: string; colorId?: string; defaultExpanded: boolean }
> = {
  needsYou: {
    label: 'Needs You',
    iconId: 'bell-dot',
    colorId: 'charts.orange',
    defaultExpanded: true,
  },
  working: {
    label: 'Working',
    iconId: 'sync~spin',
    colorId: 'charts.blue',
    defaultExpanded: true,
  },
  done: {
    label: 'Done',
    iconId: 'pass',
    colorId: 'charts.green',
    defaultExpanded: true,
  },
  idle: {
    label: 'Idle',
    iconId: 'circle-outline',
    defaultExpanded: false,
  },
};

function iconForSession(term: HcTerminal): vscode.ThemeIcon {
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
      return new vscode.ThemeIcon('circle-outline');
  }
}

export class SessionBucketItem extends vscode.TreeItem {
  constructor(
    readonly bucket: SessionBucket,
    readonly terminals: HcTerminal[]
  ) {
    const meta = BUCKET_META[bucket];
    super(
      meta.label,
      meta.defaultExpanded
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed
    );
    this.contextValue = 'herdrSessionBucket';
    this.description = `${terminals.length}`;
    this.iconPath = meta.colorId
      ? new vscode.ThemeIcon(meta.iconId, new vscode.ThemeColor(meta.colorId))
      : new vscode.ThemeIcon(meta.iconId);
  }
}

export class SessionTreeItem extends vscode.TreeItem {
  constructor(
    readonly terminal: HcTerminal,
    spaceName?: string
  ) {
    const prog = detectAgentProgram(terminal);
    const rawTitle = terminal.status?.title || terminal.title || terminal.name || '';
    const displayTitle = rawTitle.trim() || spaceName || (terminal.cwd ? path.basename(terminal.cwd) : terminal.address);
    super(`[${prog.label}] ${displayTitle}`, vscode.TreeItemCollapsibleState.None);

    this.contextValue = 'herdrSession';
    this.iconPath = iconForSession(terminal);

    const progress =
      typeof terminal.status?.progress === 'number' ? `${terminal.status.progress}%` : '';
    const msgSnippet = terminal.status?.msg?.trim()
      ? terminal.status.msg.trim().slice(0, 48)
      : '';
    const age = formatRelativeTime(terminal.status_ms || terminal.created_ms);
    const location = spaceName || (terminal.cwd ? path.basename(terminal.cwd) : terminal.address);

    this.description = [location, progress || msgSnippet, age].filter(Boolean).join(' · ');

    const sessionId = terminal.labels?.['alma.session'];
    this.tooltip = [
      `${prog.label} (${terminal.address})`,
      `Status: ${terminal.status?.state ?? 'idle'}${terminal.status?.kind ? ` (${terminal.status.kind})` : ''}`,
      terminal.status?.msg ? `Message: ${terminal.status.msg}` : '',
      spaceName ? `Space: ${spaceName}` : '',
      terminal.cwd ? `CWD: ${terminal.cwd}` : '',
      sessionId ? `Session: ${sessionId}` : '',
      age ? `Updated: ${age}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    this.command = {
      command: 'herdrBridge.openTerminal',
      title: 'Open Terminal',
      arguments: [terminal.address],
    };
  }
}

export class EmptySessionItem extends vscode.TreeItem {
  constructor() {
    super('No active agent sessions', vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('info');
    this.tooltip = 'Start an agent session (omp, pi, claude, codex, agy) in any Herdr terminal to monitor it here.';
  }
}

export type SessionTreeElement = SessionBucketItem | SessionTreeItem | EmptySessionItem;

export class SessionsTreeProvider
  implements vscode.TreeDataProvider<SessionTreeElement>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly sub: vscode.Disposable;

  constructor(private readonly hub: HerdrHub) {
    this.sub = this.hub.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  getBadge(): vscode.ViewBadge | undefined {
    const summary = this.hub.getSessionSummary();
    if (summary.needsYou > 0) {
      return {
        value: summary.needsYou,
        tooltip: `${summary.needsYou} session(s) need attention`,
      };
    }
    if (summary.working > 0) {
      return {
        value: summary.working,
        tooltip: `${summary.working} session(s) working`,
      };
    }
    return undefined;
  }

  getTreeItem(element: SessionTreeElement): vscode.TreeItem {
    return element;
  }

  getChildren(element?: SessionTreeElement): SessionTreeElement[] {
    if (!element) {
      const grouped: Record<SessionBucket, HcTerminal[]> = {
        needsYou: [],
        working: [],
        done: [],
        idle: [],
      };
      for (const term of this.hub.getTerminals()) {
        const bucket = classifySessionBucket(term);
        if (bucket) {
          grouped[bucket].push(term);
        }
      }

      const buckets: SessionBucketItem[] = [];
      for (const bucket of ['needsYou', 'working', 'done', 'idle'] as const) {
        if (grouped[bucket].length > 0) {
          grouped[bucket].sort(
            (a, b) => (b.status_ms ?? b.created_ms) - (a.status_ms ?? a.created_ms)
          );
          buckets.push(new SessionBucketItem(bucket, grouped[bucket]));
        }
      }

      if (buckets.length === 0) {
        return [new EmptySessionItem()];
      }
      return buckets;
    }

    if (element instanceof SessionBucketItem) {
      return element.terminals.map(
        (t) => new SessionTreeItem(t, this.hub.getSpaceNameForTerminal(t))
      );
    }

    return [];
  }

  dispose(): void {
    this.sub.dispose();
    this._onDidChangeTreeData.dispose();
  }
}
