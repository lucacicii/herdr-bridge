import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AgentState, HcTerminal } from '../hc/types';

export type SessionBucket = 'needsYou' | 'working' | 'done' | 'idle';

export interface SessionSummary {
  needsYou: number;
  working: number;
  done: number;
  idle: number;
  total: number;
}

export interface AgentProgramInfo {
  label: string;
  isAgent: boolean;
}

const KNOWN_AGENT_APPS = new Set([
  'claude',
  'claude-code',
  'codex',
  'pi',
  'omp',
  'opencode',
  'gemini',
  'amp',
  'cursor',
  'cursor-agent',
  'copilot',
  'grok',
  'kimi',
  'kiro',
  'kiro-cli',
  'hermes',
  'crush',
  'agy',
  'antigravity',
]);

export function detectAgentProgram(term: HcTerminal): AgentProgramInfo {
  const sessionPrefix = term.labels?.['alma.session']?.split(':')[0]?.trim();
  const argv0 = term.argv?.[0] ? path.basename(term.argv[0]) : '';
  const raw =
    term.status?.app ||
    term.template ||
    term.foreground?.name ||
    sessionPrefix ||
    argv0 ||
    'shell';
  const norm = raw.toLowerCase();

  if (norm.includes('claude')) {
    return { label: 'Claude', isAgent: true };
  }
  if (norm.includes('codex')) {
    return { label: 'Codex', isAgent: true };
  }
  if (norm === 'pi' || norm.startsWith('pi ')) {
    return { label: 'Pi', isAgent: true };
  }
  if (norm === 'omp') {
    return { label: 'OMP', isAgent: true };
  }
  if (norm === 'agy' || norm.includes('antigravity')) {
    return { label: 'Antigravity', isAgent: true };
  }
  if (norm.includes('opencode')) {
    return { label: 'OpenCode', isAgent: true };
  }
  if (norm.includes('gemini')) {
    return { label: 'Gemini', isAgent: true };
  }
  if (
    KNOWN_AGENT_APPS.has(norm) ||
    Boolean(term.labels?.['alma.session']) ||
    Boolean(term.status && term.status.state)
  ) {
    return { label: raw, isAgent: true };
  }
  return { label: raw || 'shell', isAgent: false };
}

export function classifySessionBucket(term: HcTerminal): SessionBucket | null {
  const prog = detectAgentProgram(term);
  if (!prog.isAgent) {
    return null;
  }
  const state = term.status?.state ?? 'idle';
  if (state === 'blocked' || state === 'error') {
    return 'needsYou';
  }
  if (state === 'working') {
    return 'working';
  }
  if (state === 'done') {
    return 'done';
  }
  return 'idle';
}

export function summarizeSessions(terminals: HcTerminal[]): SessionSummary {
  const summary: SessionSummary = {
    needsYou: 0,
    working: 0,
    done: 0,
    idle: 0,
    total: 0,
  };
  for (const term of terminals) {
    const bucket = classifySessionBucket(term);
    if (!bucket) {
      continue;
    }
    summary[bucket] += 1;
    summary.total += 1;
  }
  return summary;
}

export function formatRelativeTime(ms?: number): string {
  if (!ms || ms <= 0) {
    return '';
  }
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 45) {
    return 'just now';
  }
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) {
    return `${mins}m ago`;
  }
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export type NotificationLevel = 'all' | 'attentionOnly' | 'off';

export class SessionTransitionWatcher {
  private readonly previousStates = new Map<string, AgentState>();
  private primed = false;

  constructor(
    private readonly getNotificationLevel: () => NotificationLevel,
    private readonly getSpaceName: (term: HcTerminal) => string | undefined,
    private readonly openTerminal: (address: string) => void
  ) {}

  process(terminals: HcTerminal[]): void {
    const nextStates = new Map<string, AgentState>();

    for (const term of terminals) {
      if (!detectAgentProgram(term).isAgent) {
        continue;
      }
      const nextState: AgentState = term.status?.state ?? 'idle';
      nextStates.set(term.address, nextState);

      if (!this.primed) {
        continue;
      }

      const prevState = this.previousStates.get(term.address);
      if (prevState === nextState) {
        continue;
      }

      this.maybeNotify(term, prevState, nextState);
    }

    this.previousStates.clear();
    for (const [k, v] of nextStates) {
      this.previousStates.set(k, v);
    }
    this.primed = true;
  }

  private maybeNotify(term: HcTerminal, prevState: AgentState | undefined, nextState: AgentState): void {
    const level = this.getNotificationLevel();
    if (level === 'off') {
      return;
    }

    const prog = detectAgentProgram(term).label;
    const spaceName = this.getSpaceName(term) || (term.cwd ? path.basename(term.cwd) : term.address);
    const detail = term.status?.msg?.trim();
    const prefix = `${prog} (${spaceName} · ${term.address})`;

    if (nextState === 'blocked') {
      const text = detail ? `${prefix} needs your input: ${detail}` : `${prefix} needs your attention`;
      void vscode.window.showWarningMessage(text, 'Open Terminal').then((choice) => {
        if (choice === 'Open Terminal') {
          this.openTerminal(term.address);
        }
      });
      return;
    }

    if (nextState === 'error') {
      const text = detail ? `${prefix} error: ${detail}` : `${prefix} encountered an error`;
      void vscode.window.showErrorMessage(text, 'Open Terminal').then((choice) => {
        if (choice === 'Open Terminal') {
          this.openTerminal(term.address);
        }
      });
      return;
    }

    if (level === 'all' && prevState === 'working' && nextState === 'done') {
      const text = detail ? `${prefix} finished: ${detail}` : `${prefix} finished`;
      void vscode.window.showInformationMessage(text, 'Open Terminal').then((choice) => {
        if (choice === 'Open Terminal') {
          this.openTerminal(term.address);
        }
      });
    }
  }
}
