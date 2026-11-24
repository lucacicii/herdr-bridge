import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import type { HcTerminal, HerdrSpace } from './hc/types';
import type { HerdrHub } from './hub/herdrHub';
import type { TerminalManager } from './terminal/manager';
import type { TerminalMode } from './terminal/types';

function normalizeDir(dir?: string): string {
  if (!dir) {
    return '';
  }
  const trimmed = dir.trim();
  if (!trimmed) {
    return '';
  }
  try {
    return fs.realpathSync(trimmed);
  } catch {
    return path.resolve(trimmed);
  }
}

export interface HerdrBridgeApi {
  readonly version: 1;
  isConnected(): boolean;
  getTerminals(): HcTerminal[];
  getSpaces(): HerdrSpace[];
  readonly onDidChange: vscode.Event<void>;
  openTerminal(address: string, mode?: TerminalMode): Promise<void>;
  runAndOpen(params: {
    cwd?: string;
    line?: string;
    name?: string;
    labels?: Record<string, string>;
    spaceId?: string;
  }): Promise<{ address: string; spaceId?: string }>;
  sendTextToActive(text: string): Promise<boolean>;
  renameSpace(spaceId: string, name: string): Promise<void>;
  refresh(): Promise<void>;
}

export function createHerdrBridgeApi(
  hub: HerdrHub,
  terminalManager: TerminalManager
): HerdrBridgeApi {
  return {
    version: 1,
    isConnected: () => hub.getConnectionState() === 'connected',
    getTerminals: () => hub.getTerminals(),
    getSpaces: () => hub.getSpaces(),
    onDidChange: hub.onDidChange,
    openTerminal: async (address, mode) => {
      await terminalManager.openTerminal(address, mode);
    },
    runAndOpen: async (params) => {
      const created = await hub.client.runTerminal({
        cwd: params.cwd,
        line: params.line,
        name: params.name,
        keep: true,
        labels: params.labels,
      });
      let targetSpaceId = params.spaceId;
      const normCwd = normalizeDir(params.cwd);
      if (!targetSpaceId && normCwd) {
        const matched = hub
          .getSpaces()
          .find((sp) => normalizeDir(sp.folder) === normCwd);
        targetSpaceId = matched?.id;
      }
      if (targetSpaceId && hub.herdrApp.isAvailable()) {
        await hub.herdrApp
          .keepTerminalInSpace(created.address, targetSpaceId)
          .catch(() => undefined);
      }
      await hub.refresh();
      await terminalManager.openTerminal(created.address);
      return { address: created.address, spaceId: targetSpaceId };
    },
    sendTextToActive: async (text) => {
      const activeId = terminalManager.getActiveTerminalId();
      if (activeId) {
        await terminalManager.sendTextToTerminal(activeId, text);
        return true;
      }
      const firstLive = hub.getTerminals().find((t) => t.state === 'live');
      if (!firstLive) {
        return false;
      }
      await terminalManager.sendTextToTerminal(firstLive.address, text);
      return true;
    },
    renameSpace: async (spaceId, name) => {
      await hub.herdrApp.renameSpace(spaceId, name);
      await hub.refresh();
    },
    refresh: () => hub.refresh(),
  };
}
