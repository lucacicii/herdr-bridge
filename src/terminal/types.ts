import type * as vscode from 'vscode';
import type { HcTerminal } from '../hc/types';

export type TerminalMode = 'native' | 'webview';

export interface HerdrTerminalHandle extends vscode.Disposable {
  readonly terminalId: string;
  readonly mode: TerminalMode;
  reveal(): void;
  sendText(text: string, bracketed?: boolean): void;
  onDidDispose(listener: () => void): vscode.Disposable;
}

export function formatTerminalDisplayName(term: HcTerminal): string {
  const label = term.name?.trim() || term.title?.trim() || term.address;
  return `${label} (${term.address})`;
}
