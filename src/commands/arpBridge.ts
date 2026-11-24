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
}

interface AgentResumePanelApi {
  readonly version: 1;
  readonly onDidChangeSessions: vscode.Event<void>;
  findSessionForTerminal(query: {
    provider?: string;
    sessionId?: string;
    cwd?: string;
    title?: string;
    updatedNearMs?: number;
  }): ArpSessionInfo | undefined;
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

  resolveForTerminal(term: HcTerminal): ArpSessionInfo | undefined {
    if (!this.api) {
      return undefined;
    }
    const ref = extractArpSessionRef(term);
    if (!ref) {
      return undefined;
    }
    return this.api.findSessionForTerminal({
      provider: ref.provider,
      sessionId: ref.id,
      cwd: ref.projectPath,
      title: ref.title,
      updatedNearMs: term.status_ms || term.created_ms,
    });
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
  action: ArpActionKind,
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
  const resolved = resolver?.resolveForTerminal(term);
  const extracted = extractArpSessionRef(term);
  const payload = resolved
    ? {
        provider: resolved.provider,
        id: resolved.id,
        title: resolved.title,
        projectPath: resolved.projectPath,
      }
    : extracted?.id
      ? {
          provider: extracted.provider,
          id: extracted.id,
          title: extracted.title,
          projectPath: extracted.projectPath,
        }
      : undefined;

  if (!payload) {
    void vscode.window.showInformationMessage(
      `Terminal ${term.address} does not carry a matched Agent Resume session.`
    );
    return;
  }

  try {
    await vscode.commands.executeCommand(ARP_COMMANDS[action], payload);
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Failed to invoke Agent Resume Panel: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
