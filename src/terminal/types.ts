import * as path from 'node:path';
import type * as vscode from 'vscode';
import type { HcTerminal } from '../hc/types';

export type TerminalMode = 'native' | 'webview';

export interface HerdrTerminalHandle extends vscode.Disposable {
  readonly terminalId: string;
  readonly mode: TerminalMode;
  reveal(preserveFocus?: boolean): void;
  sendText(text: string, bracketed?: boolean): void;
  onDidDispose(listener: () => void): vscode.Disposable;
}

function cleanSnippet(raw: string, maxLen = 48): string {
  const cleaned = raw
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`~#]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= maxLen) {
    return cleaned;
  }
  return `${cleaned.slice(0, maxLen - 1)}…`;
}

export function formatForegroundCommand(term: HcTerminal): string | undefined {
  const fg = term.foreground;
  if (!fg) {
    const argv0 = term.argv?.[0] ? path.basename(term.argv[0]) : '';
    return argv0 || undefined;
  }
  const name = fg.name?.trim() || (fg.argv?.[0] ? path.basename(fg.argv[0]) : '');
  const argv = fg.argv ?? [];
  if ((name === 'node' || name === 'bun' || name === 'python' || name === 'python3') && argv.length > 1) {
    const script = path.basename(argv[1]);
    const rest = argv.slice(2, 4).filter((a) => !a.startsWith('-'));
    return [script, ...rest].filter(Boolean).join(' ') || name;
  }
  return name || undefined;
}

export function formatTerminalDisplayName(term: HcTerminal, syncedSessionTitle?: string): string {
  const title =
    syncedSessionTitle?.trim() ||
    term.name?.trim() ||
    term.status?.title?.trim() ||
    term.title?.trim() ||
    (term.status?.msg ? cleanSnippet(term.status.msg) : '') ||
    formatForegroundCommand(term);

  if (!title || title === term.address) {
    return term.address;
  }
  return `${title} (${term.address})`;
}
