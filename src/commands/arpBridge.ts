import { normalizeDir } from '../api';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { HcTerminal } from '../hc/types';

const ARP_EXTENSION_IDS = ['wuzhengzhe.agent-resume-panel', 'lucacicii.agent-resume-panel-v2'];

export interface ArpSessionInfo {
  provider: string;
  id: string;
  title: string;
  projectPath: string;
  summary?: string;
  updatedAt?: number;
}

export interface ArpLinkSessionResult {
  ok: boolean;
  reason?: 'runs-other-session' | 'write-failed';
  detail?: string;
}

export interface ArpUnlinkSessionResult {
  ok: boolean;
  reason?: 'write-failed';
  detail?: string;
}

interface AgentResumePanelApi {
  readonly version: 1;
  readonly onDidChangeSessions: vscode.Event<void>;
  listSessions?(): ArpSessionInfo[];
  findSessionForTerminal(query: {
    provider?: string;
    sessionId?: string;
    cwd?: string;
    title?: string;
    updatedNearMs?: number;
  }): ArpSessionInfo | undefined;
  linkSessionToTerminal?(
    session: { provider: string; id: string },
    address: string
  ): Promise<ArpLinkSessionResult>;
  unlinkSessionFromTerminal?(
    session: { provider: string; id: string },
    address: string
  ): Promise<ArpUnlinkSessionResult>;
}

export function isArpInstalled(): boolean {
  return ARP_EXTENSION_IDS.some((id) => Boolean(vscode.extensions.getExtension(id)));
}

export async function syncArpContext(): Promise<void> {
  await vscode.commands.executeCommand('setContext', 'herdrBridge.arpAvailable', isArpInstalled());
}

function normalizeProviderAlias(raw: string): string | undefined {
  const norm = raw.toLowerCase();
  if (norm.includes('claude')) return 'claude';
  if (norm.includes('codex')) return 'codex';
  if (norm === 'omp' || norm.startsWith('omp ')) return 'omp';
  if (norm === 'pi' || norm.startsWith('pi ')) return 'pi';
  if (norm === 'agy' || norm.includes('antigravity')) return 'agy';
  if (norm.includes('opencode')) return 'opencode';
  if (norm.includes('grok')) return 'grok';
  if (norm.includes('cursor')) return 'cursor';
  if (norm.includes('prime')) return 'prime';
  return undefined;
}

export function extractArpSessionRef(
  term: HcTerminal
): { provider: string; id?: string; title: string; projectPath: string } | undefined {
  const title = term.status?.title || term.title || term.name || term.address;
  const projectPath = term.foreground?.cwd || term.cwd || term.labels?.workspace || '';

  const alma = term.labels?.['alma.session']?.trim();
  if (alma) {
    const parts = alma.split(':');
    const provider = normalizeProviderAlias(parts[0] ?? '');
    const id = parts.length >= 3 && parts[1] === 'id' ? parts.slice(2).join(':').trim() : parts[1]?.trim();
    if (provider && id) {
      return { provider, id, title, projectPath };
    }
  }

  const argv = [...(term.foreground?.argv ?? []), ...(term.argv ?? [])];
  const rawApp =
    term.status?.app ||
    term.template ||
    term.foreground?.name ||
    (argv[0] ? path.basename(argv[0]) : '');
  const provider = rawApp ? normalizeProviderAlias(rawApp) : undefined;
  if (!provider) {
    return undefined;
  }

  // A previous unlink left a tombstone: do not re-derive the id from the resume flag in
  // argv. An explicit `alma.session` label still wins - a later link rewrites it and
  // removes the tombstone.
  if (term.labels?.['alma.session.unlinked']) {
    return { provider, title, projectPath };
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (
      (arg === '--resume' || arg === '-r' || arg === '--session' || arg === '--conversation') &&
      argv[i + 1] &&
      !argv[i + 1].startsWith('-')
    ) {
      return { provider, id: argv[i + 1], title, projectPath };
    }
    for (const prefix of ['--resume=', '--session=', '--conversation=']) {
      if (arg.startsWith(prefix)) {
        const val = arg.slice(prefix.length).trim();
        if (val) {
          return { provider, id: val, title, projectPath };
        }
      }
    }
    if (arg === 'resume' && provider === 'codex') {
      for (let j = i + 1; j < argv.length; j++) {
        const next = argv[j];
        if (next === '--cd' || next === '-C') {
          j++;
          continue;
        }
        if (!next.startsWith('-')) {
          return { provider, id: next, title, projectPath };
        }
      }
    }
  }

  return { provider, title, projectPath };
}

export class ArpSessionResolver implements vscode.Disposable {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  private api: AgentResumePanelApi | undefined;
  private sub: vscode.Disposable | undefined;
  private connecting = false;
  private disposed = false;

  async initialize(): Promise<void> {
    await this.ensureConnected();
  }

  async ensureConnected(): Promise<void> {
    if (this.disposed || this.api || this.connecting) {
      return;
    }
    this.connecting = true;
    try {
      for (const id of ARP_EXTENSION_IDS) {
        const ext = vscode.extensions.getExtension<AgentResumePanelApi>(id);
        if (!ext) {
          continue;
        }
        const api = ext.isActive ? ext.exports : await ext.activate();
        if (api && api.version === 1) {
          this.api = api;
          this.sub?.dispose();
          this.sub = api.onDidChangeSessions(() => {
            this.onDidChangeEmitter.fire();
          });
          this.onDidChangeEmitter.fire();
          return;
        }
      }
    } catch {
      // ARP may not be installed or may be an older version
    } finally {
      this.connecting = false;
    }
  }

  listSessions(): ArpSessionInfo[] {
    return this.api?.listSessions?.() ?? [];
  }

  getApi(): AgentResumePanelApi | undefined {
    return this.api;
  }

  resolveForTerminal(term: HcTerminal): ArpSessionInfo | undefined {
    if (!this.api) {
      return undefined;
    }
    const ref = extractArpSessionRef(term);
    if (!ref?.id) {
      return undefined;
    }
    // Titles and context actions must follow an exact id match only: a directory-based
    // guess can name a different session and act on the wrong one.
    const resolved = this.api.findSessionForTerminal({
      provider: ref.provider,
      sessionId: ref.id,
    });
    if (!resolved || resolved.id !== ref.id || resolved.provider !== ref.provider) {
      return undefined;
    }
    return resolved;
  }

  dispose(): void {
    this.disposed = true;
    this.sub?.dispose();
    this.sub = undefined;
    this.onDidChangeEmitter.dispose();
  }
}

export type ArpActionKind = 'preview' | 'note' | 'gtd';

const ARP_COMMANDS: Record<ArpActionKind, string> = {
  preview: 'agentResume.previewSession',
  note: 'agentResume.openSessionNote',
  gtd: 'agentResume.setSessionGtdStatus',
};

export async function invokeArpActionForTerminal(
  term: HcTerminal | undefined,
  action: ArpActionKind
): Promise<void> {
  if (!isArpInstalled()) {
    void vscode.window.showWarningMessage(
      'Agent Resume Panel extension is not installed in VS Code.'
    );
    return;
  }
  if (!term) {
    return;
  }

  const extracted = extractArpSessionRef(term);
  if (!extracted?.id) {
    void vscode.window.showInformationMessage(
      `Terminal ${term.address} has no linked Agent Resume session. Use "Link Terminal to Agent Resume Session..." to pick one.`
    );
    return;
  }

  const payload = {
    provider: extracted.provider,
    id: extracted.id,
    title: extracted.title,
    projectPath: extracted.projectPath,
  };

  try {
    await vscode.commands.executeCommand(ARP_COMMANDS[action], payload);
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Failed to invoke Agent Resume Panel: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export interface ArpLabelTarget {
  getTerminal(address: string): Promise<HcTerminal | undefined>;
  refresh(): Promise<unknown>;
}

/**
 * Another resident app (Alma) re-asserts `alma.session` within ~1.5 s of our write, so
 * re-read the label after it settles and warn when the write did not stick.
 */
const LABEL_SETTLE_MS = 2500;

function verifyLinkSettled(target: ArpLabelTarget, address: string, expected: string): void {
  setTimeout(() => {
    void target
      .getTerminal(address)
      .then((term) => {
        if (!term) {
          return;
        }
        const label = term.labels?.['alma.session']?.trim();
        if (label !== expected) {
          void vscode.window.showWarningMessage(
            `The Agent Resume link on ${address} was overwritten by another app (now ${
              label || '(none)'
            }). The terminal may be running a different session.`
          );
        }
      })
      .catch(() => undefined);
  }, LABEL_SETTLE_MS);
}

function verifyUnlinkSettled(target: ArpLabelTarget, address: string): void {
  setTimeout(() => {
    void target
      .getTerminal(address)
      .then((term) => {
        const label = term?.labels?.['alma.session']?.trim();
        if (label) {
          void vscode.window.showWarningMessage(
            `Another app re-asserted the Agent Resume session (${label}) on ${address}; the terminal demonstrably runs that session, so the link came back.`
          );
        }
      })
      .catch(() => undefined);
  }, LABEL_SETTLE_MS);
}

export async function linkTerminalToArpSession(
  target: ArpLabelTarget,
  term: HcTerminal | undefined,
  resolver?: ArpSessionResolver
): Promise<void> {
  if (!isArpInstalled()) {
    void vscode.window.showWarningMessage(
      'Agent Resume Panel extension is not installed in VS Code.'
    );
    return;
  }
  if (!term) {
    return;
  }

  if (resolver) {
    await resolver.ensureConnected();
  }
  const api = resolver?.getApi();
  if (!api?.linkSessionToTerminal) {
    void vscode.window.showErrorMessage(
      'The installed Agent Resume Panel does not support linking terminals. Update Agent Resume Panel.'
    );
    return;
  }
  const sessions = resolver?.listSessions() ?? [];
  if (sessions.length === 0) {
    void vscode.window.showInformationMessage(
      'Agent Resume Panel is not connected or has no sessions to link.'
    );
    return;
  }

  // Sessions in this terminal's project first, then most recently updated.
  const termCwd = normalizeDir(term.cwd || term.labels?.workspace || term.foreground?.cwd);
  const inProject = (session: ArpSessionInfo): boolean =>
    Boolean(termCwd && session.projectPath && normalizeDir(session.projectPath) === termCwd);
  const sorted = [...sessions].sort((a, b) => {
    const dirDiff = Number(inProject(a)) - Number(inProject(b));
    if (dirDiff !== 0) {
      return dirDiff;
    }
    return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  });

  const picked = await vscode.window.showQuickPick(
    sorted.map((session) => ({
      label: session.title || session.id,
      description: `${session.provider} · ${session.projectPath}${
        session.updatedAt ? ` · ${new Date(session.updatedAt).toLocaleDateString()}` : ''
      }`,
      detail: session.id,
      session,
    })),
    {
      title: `Link ${term.address} to an Agent Resume session`,
      placeHolder: 'Choose the session this terminal is running',
      matchOnDescription: true,
      matchOnDetail: true,
    }
  );
  if (!picked) {
    return;
  }

  const session = picked.session;
  const expected = `${session.provider}:id:${session.id}`;
  let result: ArpLinkSessionResult;
  try {
    result = await api.linkSessionToTerminal(
      { provider: session.provider, id: session.id },
      term.address
    );
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Failed to link terminal in Agent Resume Panel: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }
  if (!result.ok) {
    if (result.reason === 'runs-other-session') {
      void vscode.window.showWarningMessage(
        `Terminal ${term.address} is currently running session ${
          result.detail ?? '(unknown)'
        }; the link was refused.`
      );
    } else {
      void vscode.window.showErrorMessage(
        `Failed to link ${term.address} to ${session.provider}:${session.id}${
          result.detail ? `: ${result.detail}` : ''
        }.`
      );
    }
    return;
  }
  await target.refresh();
  verifyLinkSettled(target, term.address, expected);
  void vscode.window.showInformationMessage(
    `Linked ${term.address} to ${session.provider}:${session.id}.`
  );
}

export async function unlinkTerminalFromArpSession(
  target: ArpLabelTarget,
  term: HcTerminal | undefined,
  resolver?: ArpSessionResolver
): Promise<void> {
  if (!term) {
    return;
  }
  const ref = extractArpSessionRef(term);
  if (!ref?.id) {
    void vscode.window.showInformationMessage(
      `Terminal ${term.address} has no Agent Resume session link.`
    );
    return;
  }
  if (resolver) {
    await resolver.ensureConnected();
  }
  const api = resolver?.getApi();
  if (!api?.unlinkSessionFromTerminal) {
    void vscode.window.showErrorMessage(
      'The installed Agent Resume Panel does not support unlinking terminals. Update Agent Resume Panel.'
    );
    return;
  }

  let result: ArpUnlinkSessionResult;
  try {
    result = await api.unlinkSessionFromTerminal(
      { provider: ref.provider, id: ref.id },
      term.address
    );
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Failed to unlink terminal in Agent Resume Panel: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }
  if (!result.ok) {
    void vscode.window.showErrorMessage(
      `Failed to unlink ${term.address}${result.detail ? `: ${result.detail}` : ''}.`
    );
    return;
  }
  await target.refresh();
  verifyUnlinkSettled(target, term.address);
  void vscode.window.showInformationMessage(
    `Removed the Agent Resume link from ${term.address}.`
  );
}
