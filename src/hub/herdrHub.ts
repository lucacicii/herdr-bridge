import * as path from 'node:path';
import * as vscode from 'vscode';
import { HcClient, type HcEventStream } from '../hc/client';
import { checkEnvironment, ensureDaemonIfInstalled, findHcBinary, startDaemon } from '../hc/detector';
import { HerdrAppClient } from '../hc/happ';
import type { HcAppDoc, HcAppSpace, HcEnvStatus, HcTerminal, HerdrSpace } from '../hc/types';
import { summarizeSessions, type SessionSummary } from './sessionMonitor';

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

function sortTerminalsByPriority(terms: HcTerminal[]): HcTerminal[] {
  const rank = (t: HcTerminal): number => {
    const s = t.status?.state;
    if (s === 'blocked' || s === 'error') return 0;
    if (s === 'working') return 1;
    if (s === 'done') return 2;
    return 3;
  };
  return [...terms].sort((a, b) => {
    const diff = rank(a) - rank(b);
    return diff !== 0 ? diff : b.created_ms - a.created_ms;
  });
}

export class HerdrHub implements vscode.Disposable {
  readonly client: HcClient;
  readonly herdrApp = new HerdrAppClient();
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private envStatus: HcEnvStatus | undefined;
  private terminals: HcTerminal[] = [];
  private appSpaces: HcAppSpace[] = [];
  private connectionState: ConnectionState = 'disconnected';
  private eventStream: HcEventStream | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private refreshDebounceTimer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(socketPath: string) {
    this.client = new HcClient(socketPath);
  }

  getEnvStatus(): HcEnvStatus | undefined {
    return this.envStatus;
  }

  getTerminals(): HcTerminal[] {
    return this.terminals;
  }

  getTerminalById(address: string): HcTerminal | undefined {
    return this.terminals.find((t) => t.address === address);
  }

  getSpaces(): HerdrSpace[] {
    const spaceMap = new Map<string, HerdrSpace>();
    for (const sp of this.appSpaces) {
      if (!sp.id) {
        continue;
      }
      const folder = sp.folder || '';
      const explicitName = sp.name?.trim();
      const folderBase = folder ? path.basename(folder) : '';
      spaceMap.set(sp.id, {
        id: sp.id,
        name: explicitName || folderBase || '',
        folder,
        terminals: [],
      });
    }

    for (const term of this.terminals) {
      const spaceId = term.labels?.['herdr.space'];
      if (!spaceId) {
        continue;
      }
      let entry = spaceMap.get(spaceId);
      if (!entry) {
        const whereName = term.labels?.where?.split(' / ')[0]?.trim();
        const folder = term.labels?.workspace || term.cwd || '';
        const folderBase = folder ? path.basename(folder) : '';
        entry = {
          id: spaceId,
          name: whereName || folderBase || '',
          folder,
          terminals: [],
        };
        spaceMap.set(spaceId, entry);
      } else if (!entry.name) {
        const whereName = term.labels?.where?.split(' / ')[0]?.trim();
        const cwdBase = term.cwd ? path.basename(term.cwd) : '';
        entry.name = whereName || cwdBase;
      }
      entry.terminals.push(term);
    }

    const spaces: HerdrSpace[] = [];
    for (const entry of spaceMap.values()) {
      if (!entry.name) {
        const firstTerm = entry.terminals[0];
        const whereName = firstTerm?.labels?.where?.split(' / ')[0]?.trim();
        const cwdBase = firstTerm?.cwd ? path.basename(firstTerm.cwd) : '';
        entry.name = whereName || cwdBase || entry.id;
      }
      entry.terminals = sortTerminalsByPriority(entry.terminals);
      spaces.push(entry);
    }
    return spaces;
  }

  getUnassignedTerminals(): HcTerminal[] {
    return sortTerminalsByPriority(
      this.terminals.filter((t) => !t.labels?.['herdr.space'])
    );
  }

  getSpaceNameForTerminal(term: HcTerminal): string | undefined {
    const spaceId = term.labels?.['herdr.space'];
    if (!spaceId) {
      return undefined;
    }
    const found = this.getSpaces().find((s) => s.id === spaceId);
    return found?.name;
  }

  getSessionSummary(): SessionSummary {
    return summarizeSessions(this.terminals);
  }

  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  getBlockedCount(): number {
    return this.terminals.filter(
      (t) => t.state === 'live' && (t.status?.state === 'blocked' || t.status?.state === 'error')
    ).length;
  }

  async initialize(autoStartDaemon: boolean): Promise<void> {
    this.connectionState = 'connecting';
    this._onDidChange.fire();

    if (autoStartDaemon) {
      await ensureDaemonIfInstalled(this.client);
    }

    await this.refresh();
    this.startEventLoop();
  }

  setSocketPath(socketPath: string): void {
    this.client.setSocketPath(socketPath);
    this.stopEventLoop();
    void this.refresh().then(() => {
      if (!this.disposed) {
        this.startEventLoop();
      }
    });
  }

  private async fetchAppSpaces(): Promise<HcAppSpace[]> {
    try {
      const doc = await this.client.docGet<HcAppDoc>('herdr-app');
      return Array.isArray(doc?.spaces) ? doc.spaces : [];
    } catch {
      return [];
    }
  }

  async refresh(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const env = await checkEnvironment(this.client);
    const appPath = this.herdrApp.getPath(true);
    env.herdrApp = {
      installed: Boolean(appPath),
      path: appPath,
    };
    this.envStatus = env;

    if (env.daemon.running) {
      this.connectionState = 'connected';
      try {
        const [list, spaces] = await Promise.all([
          this.client.listTerminals(false),
          this.fetchAppSpaces(),
        ]);
        this.terminals = list.terminals ?? [];
        this.appSpaces = spaces;
      } catch {
        this.terminals = [];
        this.appSpaces = [];
      }
    } else {
      this.connectionState = 'disconnected';
      this.terminals = [];
      this.appSpaces = [];
    }

    this._onDidChange.fire();
  }

  async startLocalDaemon(): Promise<boolean> {
    const hcPath = findHcBinary();
    if (!hcPath) {
      return false;
    }
    await startDaemon(hcPath);
    await this.refresh();
    if (!this.eventStream && !this.disposed) {
      this.startEventLoop();
    }
    return Boolean(this.envStatus?.daemon.running);
  }

  private scheduleRefresh(delayMs = 150): void {
    if (this.disposed) {
      return;
    }
    if (this.refreshDebounceTimer) {
      clearTimeout(this.refreshDebounceTimer);
    }
    this.refreshDebounceTimer = setTimeout(() => {
      this.refreshDebounceTimer = undefined;
      void this.refresh();
    }, delayMs);
  }

  private scheduleReconnect(delayMs: number): void {
    if (this.disposed || this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.startEventLoop();
    }, delayMs);
  }

  private stopEventLoop(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.eventStream) {
      this.eventStream.removeAllListeners();
      this.eventStream.close();
      this.eventStream = undefined;
    }
  }

  private startEventLoop(): void {
    if (this.disposed || this.eventStream) {
      return;
    }
    void this.connectEvents();
  }

  private async connectEvents(): Promise<void> {
    if (this.disposed) {
      return;
    }
    try {
      const stream = await this.client.subscribeEvents();
      if (this.disposed) {
        stream.close();
        return;
      }

      this.eventStream = stream;
      this.connectionState = 'connected';
      this.terminals = stream.initial.terminals ?? [];
      this.appSpaces = await this.fetchAppSpaces();
      const env = await checkEnvironment(this.client);
      const appPath = this.herdrApp.getPath(true);
      env.herdrApp = { installed: Boolean(appPath), path: appPath };
      this.envStatus = env;
      this._onDidChange.fire();

      stream.on('event', () => {
        this.scheduleRefresh(120);
      });

      stream.on('close', () => {
        if (this.eventStream === stream) {
          this.eventStream = undefined;
        }
        if (!this.disposed) {
          this.connectionState = 'disconnected';
          void this.refresh();
          this.scheduleReconnect(800);
        }
      });
    } catch {
      if (!this.disposed) {
        this.connectionState = 'disconnected';
        this.scheduleReconnect(2000);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.refreshDebounceTimer) {
      clearTimeout(this.refreshDebounceTimer);
    }
    this.stopEventLoop();
    this._onDidChange.dispose();
  }
}
