import * as vscode from 'vscode';
import { createHerdrBridgeApi, type HerdrBridgeApi } from './api';
import { ArpSessionResolver, invokeArpActionForTerminal, syncArpContext } from './commands/arpBridge';
import { sendSelectionToActiveTerminal } from './commands/editorRefs';
import { findHcBinary } from './hc/detector';
import type { HcTerminal } from './hc/types';
import { HerdrHub } from './hub/herdrHub';
import { SessionTransitionWatcher, type NotificationLevel } from './hub/sessionMonitor';
import { TerminalManager } from './terminal/manager';
import type { TerminalMode } from './terminal/types';
import { SessionsTreeProvider } from './views/sessionsTreeProvider';
import { HerdrStatusBar } from './views/statusBar';
import { StatusTreeProvider } from './views/statusTreeProvider';
import {
  SpaceTreeItem,
  TerminalsTreeProvider,
  type TerminalTreeItem,
} from './views/terminalsTreeProvider';

function getConfiguredSocketPath(): string {
  return vscode.workspace.getConfiguration('herdrBridge').get<string>('socketPath', '').trim();
}

function getAutoStartConfig(): boolean {
  return vscode.workspace.getConfiguration('herdrBridge').get<boolean>('autoStartDaemon', true);
}

function resolveTerminalIdArg(arg: unknown): string | undefined {
  if (typeof arg === 'string' && arg) {
    return arg;
  }
  if (arg && typeof arg === 'object' && 'terminal' in arg) {
    const item = arg as TerminalTreeItem;
    return item.terminal?.address;
  }
  return undefined;
}

function resolveTerminalFromArg(hub: HerdrHub, arg: unknown): HcTerminal | undefined {
  if (arg && typeof arg === 'object' && 'terminal' in arg) {
    const item = arg as TerminalTreeItem;
    return item.terminal;
  }
  const id = resolveTerminalIdArg(arg);
  return id ? hub.getTerminalById(id) : undefined;
}

export async function activate(context: vscode.ExtensionContext): Promise<HerdrBridgeApi> {
  const hub = new HerdrHub(getConfiguredSocketPath());
  const arpResolver = new ArpSessionResolver();
  const terminalManager = new TerminalManager(context.extensionUri, hub, context.workspaceState);
  let hubInitPromise: Promise<void> | undefined;
  const statusProvider = new StatusTreeProvider(hub, terminalManager);
  const sessionsProvider = new SessionsTreeProvider(hub, (t) => arpResolver.resolveForTerminal(t));
  const terminalsProvider = new TerminalsTreeProvider(hub, (t) => arpResolver.resolveForTerminal(t));
  const statusBar = new HerdrStatusBar(hub, terminalManager);

  const sessionsTreeView = vscode.window.createTreeView('herdrBridge.sessionsView', {
    treeDataProvider: sessionsProvider,
    showCollapseAll: true,
  });

  const watcher = new SessionTransitionWatcher(
    () =>
      vscode.workspace
        .getConfiguration('herdrBridge')
        .get<NotificationLevel>('notifications', 'all'),
    (term) => hub.getSpaceNameForTerminal(term),
    (address) => {
      void terminalManager.openTerminal(address);
    }
  );

  const updateMonitoring = (): void => {
    sessionsTreeView.badge = sessionsProvider.getBadge();
    watcher.process(hub.getTerminals());
  };

  context.subscriptions.push(
    hub,
    arpResolver,
    terminalManager,
    statusProvider,
    sessionsProvider,
    sessionsTreeView,
    terminalsProvider,
    statusBar,
    hub.onDidChange(updateMonitoring),
    arpResolver.onDidChange(() => {
      sessionsProvider.refresh();
      terminalsProvider.refresh();
    }),
    vscode.extensions.onDidChange(() => {
      void syncArpContext();
      void arpResolver.ensureConnected();
    }),
    vscode.window.registerTreeDataProvider('herdrBridge.statusView', statusProvider),
    vscode.window.registerTreeDataProvider('herdrBridge.terminalsView', terminalsProvider),
    vscode.window.registerWebviewPanelSerializer('herdrBridge.xtermTerminal', {
      async deserializeWebviewPanel(panel, state) {
        await hubInitPromise?.catch(() => undefined);
        await terminalManager.reviveWebviewPanel(panel, state);
      },
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('herdrBridge.socketPath')) {
        hub.setSocketPath(getConfiguredSocketPath());
      }
      if (e.affectsConfiguration('herdrBridge.terminalMode')) {
        statusProvider.refresh();
        statusBar.update();
      }
    })
  );

  const pickLiveTerminalId = async (): Promise<string | undefined> => {
    const terms = hub.getTerminals();
    if (terms.length === 0) {
      void vscode.window.showInformationMessage('No active herdr-core terminals found.');
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      terms.map((t) => ({
        label: t.name?.trim() || t.title?.trim() || t.address,
        description: `${t.address} · ${t.status?.state ?? t.state}`,
        detail: t.cwd,
        terminalId: t.address,
      })),
      { placeHolder: 'Select a herdr-core terminal' }
    );
    return picked?.terminalId;
  };

  const openWithMode = async (arg: unknown, mode?: TerminalMode): Promise<void> => {
    const terminalId = resolveTerminalIdArg(arg) ?? (await pickLiveTerminalId());
    if (!terminalId) {
      return;
    }
    try {
      await terminalManager.openTerminal(terminalId, mode);
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Failed to open terminal ${terminalId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('herdrBridge.refresh', () => hub.refresh()),

    vscode.commands.registerCommand('herdrBridge.startDaemon', async () => {
      const hcPath = findHcBinary();
      if (!hcPath) {
        const action = await vscode.window.showWarningMessage(
          'herdr-core (hc) CLI was not found on this machine.',
          'Install herdr-core'
        );
        if (action === 'Install herdr-core') {
          await vscode.commands.executeCommand('herdrBridge.installCore');
        }
        return;
      }
      try {
        const started = await hub.startLocalDaemon();
        if (started) {
          void vscode.window.showInformationMessage('herdr-core daemon started.');
        } else {
          void vscode.window.showWarningMessage(
            `Ran ${hcPath} server start, but socket is still unreachable.`
          );
        }
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Failed to start herdr-core daemon: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }),

    vscode.commands.registerCommand('herdrBridge.installCore', async () => {
      const term = vscode.window.createTerminal({ name: 'Install herdr-core' });
      term.show();
      if (process.platform === 'win32') {
        term.sendText('irm https://releases.herdr.dev/core/install.ps1 | iex; hc server start');
      } else {
        term.sendText('curl -fsSL https://releases.herdr.dev/core/install.sh | sh && hc server start');
      }
      void vscode.window
        .showInformationMessage(
          'Installing herdr-core in terminal. Click Refresh once complete.',
          'Refresh'
        )
        .then((choice) => {
          if (choice === 'Refresh') {
            void hub.refresh();
          }
        });
    }),

    vscode.commands.registerCommand('herdrBridge.switchMode', async () => {
      const current = terminalManager.getPreferredMode();
      const picked = await vscode.window.showQuickPick(
        [
          {
            label: 'Native Terminal (Mode A)',
            description: current === 'native' ? 'Current' : 'vscode.Pseudoterminal',
            mode: 'native' as const,
          },
          {
            label: 'XTerm Webview (Mode B)',
            description: current === 'webview' ? 'Current' : 'Embedded @xterm/xterm panel',
            mode: 'webview' as const,
          },
        ],
        { placeHolder: 'Choose default Herdr terminal mode' }
      );
      if (!picked || picked.mode === current) {
        return;
      }
      await vscode.workspace
        .getConfiguration('herdrBridge')
        .update('terminalMode', picked.mode, vscode.ConfigurationTarget.Global);
      statusProvider.refresh();
      statusBar.update();
    }),

    vscode.commands.registerCommand('herdrBridge.newTerminal', async () => {
      const defaultCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.env.HOME || '/';
      const cmdLine = await vscode.window.showInputBox({
        prompt: 'Command to run in new herdr-core terminal (leave empty for default shell)',
        placeHolder: 'e.g. zsh, claude, omp',
      });
      if (cmdLine === undefined) {
        return;
      }
      try {
        const created = await hub.client.runTerminal({
          cwd: defaultCwd,
          line: cmdLine.trim() || undefined,
          keep: true,
        });
        await hub.refresh();
        await terminalManager.openTerminal(created.address);
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Failed to create terminal: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }),

    vscode.commands.registerCommand('herdrBridge.openTerminal', (arg) => openWithMode(arg)),
    vscode.commands.registerCommand('herdrBridge.openTerminalNative', (arg) =>
      openWithMode(arg, 'native')
    ),
    vscode.commands.registerCommand('herdrBridge.openTerminalWebview', (arg) =>
      openWithMode(arg, 'webview')
    ),

    vscode.commands.registerCommand('herdrBridge.interruptTerminal', async (arg) => {
      const terminalId = resolveTerminalIdArg(arg);
      if (!terminalId) {
        return;
      }
      try {
        await hub.client.interruptTerminal(terminalId);
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Failed to interrupt ${terminalId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }),

    vscode.commands.registerCommand('herdrBridge.killTerminal', async (arg) => {
      const terminalId = resolveTerminalIdArg(arg);
      if (!terminalId) {
        return;
      }
      try {
        await hub.client.killTerminal(terminalId);
        terminalManager.closeTerminal(terminalId);
        await hub.refresh();
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Failed to kill ${terminalId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }),

    vscode.commands.registerCommand('herdrBridge.newSpace', async () => {
      if (!hub.herdrApp.isAvailable()) {
        void vscode.window.showWarningMessage(
          'Herdr app CLI (herdr-app) was not found. Install Herdr.app or set HERDR_APP_BIN to create Spaces.'
        );
        return;
      }
      const pickedFolder = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
        openLabel: 'Select Folder for Space',
      });
      if (!pickedFolder || pickedFolder.length === 0) {
        return;
      }
      const folder = pickedFolder[0].fsPath;
      const defaultName = folder.split('/').filter(Boolean).pop() || 'space';
      const name = await vscode.window.showInputBox({
        prompt: 'Space name',
        value: defaultName,
      });
      if (name === undefined) {
        return;
      }
      try {
        await hub.herdrApp.createSpace(name, folder);
        await hub.refresh();
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Failed to create space: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }),

    vscode.commands.registerCommand('herdrBridge.newTerminalInSpace', async (arg) => {
      const space = arg instanceof SpaceTreeItem ? arg.space : undefined;
      const cwd =
        space?.folder || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.env.HOME || '/';
      const cmdLine = await vscode.window.showInputBox({
        prompt: space
          ? `Command to run in Space "${space.name}" (leave empty for default shell)`
          : 'Command to run in new terminal',
        placeHolder: 'e.g. zsh, claude, omp',
      });
      if (cmdLine === undefined) {
        return;
      }
      try {
        const created = await hub.client.runTerminal({
          cwd,
          line: cmdLine.trim() || undefined,
          keep: true,
        });
        if (space && hub.herdrApp.isAvailable()) {
          await hub.herdrApp.keepTerminalInSpace(created.address, space.id);
        }
        await hub.refresh();
        await terminalManager.openTerminal(created.address);
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Failed to create terminal in space: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }),

    vscode.commands.registerCommand('herdrBridge.renameSpace', async (arg) => {
      if (!(arg instanceof SpaceTreeItem)) {
        return;
      }
      if (!hub.herdrApp.isAvailable()) {
        void vscode.window.showWarningMessage('Herdr app CLI (herdr-app) is required to rename Spaces.');
        return;
      }
      const nextName = await vscode.window.showInputBox({
        prompt: 'New Space name (leave empty to derive from folder)',
        value: arg.space.name,
      });
      if (nextName === undefined) {
        return;
      }
      try {
        await hub.herdrApp.renameSpace(arg.space.id, nextName.trim());
        await hub.refresh();
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Failed to rename space: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }),

    vscode.commands.registerCommand('herdrBridge.openSpaceFolder', async (arg) => {
      if (!(arg instanceof SpaceTreeItem) || !arg.space.folder) {
        return;
      }
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(arg.space.folder), {
        forceNewWindow: true,
      });
    }),

    vscode.commands.registerCommand('herdrBridge.adoptTerminalToSpace', async (arg) => {
      const terminalId = resolveTerminalIdArg(arg);
      if (!terminalId) {
        return;
      }
      if (!hub.herdrApp.isAvailable()) {
        void vscode.window.showWarningMessage('Herdr app CLI (herdr-app) is required to adopt terminals.');
        return;
      }
      const spaces = hub.getSpaces();
      if (spaces.length === 0) {
        void vscode.window.showInformationMessage('No Herdr Spaces found. Create a Space first.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        spaces.map((sp) => ({
          label: sp.name,
          description: `${sp.terminals.length} terminals`,
          detail: sp.folder,
          spaceId: sp.id,
        })),
        { placeHolder: `Adopt terminal ${terminalId} into which Space?` }
      );
      if (!picked) {
        return;
      }
      try {
        await hub.herdrApp.keepTerminalInSpace(terminalId, picked.spaceId);
        await hub.refresh();
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Failed to adopt terminal: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }),

    vscode.commands.registerCommand('herdrBridge.previewInArp', (arg) =>
      invokeArpActionForTerminal(resolveTerminalFromArg(hub, arg), 'preview', arpResolver)
    ),
    vscode.commands.registerCommand('herdrBridge.openNoteInArp', (arg) =>
      invokeArpActionForTerminal(resolveTerminalFromArg(hub, arg), 'note', arpResolver)
    ),
    vscode.commands.registerCommand('herdrBridge.setGtdInArp', (arg) =>
      invokeArpActionForTerminal(resolveTerminalFromArg(hub, arg), 'gtd', arpResolver)
    ),

    vscode.commands.registerCommand('herdrBridge.sendSelectionToTerminal', () =>
      sendSelectionToActiveTerminal(hub, terminalManager)
    )
  );

  void syncArpContext();
  void arpResolver.initialize();
  hubInitPromise = hub.initialize(getAutoStartConfig());
  void hubInitPromise.then(() => terminalManager.restoreNativeTerminals()).catch(() => undefined);
  return createHerdrBridgeApi(hub, terminalManager);
}

export function deactivate(): void {
  // All resources are registered in context.subscriptions.
}
