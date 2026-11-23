import * as path from 'node:path';
import * as vscode from 'vscode';
import type { HerdrHub } from '../hub/herdrHub';
import type { TerminalManager } from '../terminal/manager';
import { formatTerminalDisplayName } from '../terminal/types';

export function buildEditorReference(editor: vscode.TextEditor): string {
  const uri = editor.document.uri;
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  const relPath = folder ? path.relative(folder.uri.fsPath, uri.fsPath) : uri.fsPath;
  const sel = editor.selection;

  if (sel.isEmpty) {
    const line = sel.active.line + 1;
    return `@${relPath}#L${line} `;
  }

  const startLine = sel.start.line + 1;
  const endLine = sel.end.line + 1;
  const rangeTag = startLine === endLine ? `L${startLine}` : `L${startLine}-${endLine}`;
  const selectedText = editor.document.getText(sel).trim();

  if (!selectedText) {
    return `@${relPath}#${rangeTag} `;
  }
  return `@${relPath}#${rangeTag}\n\`\`\`\n${selectedText}\n\`\`\`\n`;
}

export async function sendSelectionToActiveTerminal(
  hub: HerdrHub,
  terminalManager: TerminalManager
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage('Open a file in the editor first.');
    return;
  }

  let targetId = terminalManager.getActiveTerminalId();
  if (!targetId) {
    const terms = hub.getTerminals().filter((t) => t.state === 'live');
    if (terms.length === 0) {
      void vscode.window.showInformationMessage('No live herdr-core terminals found.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      terms.map((t) => ({
        label: formatTerminalDisplayName(t),
        description: t.cwd,
        terminalId: t.address,
      })),
      { placeHolder: 'Select a Herdr terminal to send the code reference to' }
    );
    if (!picked) {
      return;
    }
    targetId = picked.terminalId;
    await terminalManager.openTerminal(targetId);
  }

  const ref = buildEditorReference(editor);
  await terminalManager.sendTextToTerminal(targetId, ref);
}
