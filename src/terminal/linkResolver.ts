import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

export interface ParsedFileLink {
  raw: string;
  filePath: string;
  line: number;
  column: number;
  startIndex: number;
  length: number;
}

const FILE_LINK_RE = /(?:~\/|\/|\.\.?\/|[A-Za-z0-9_.-]+\/)[A-Za-z0-9_.\-\/]+\.[A-Za-z0-9]+(?::(\d+)(?::(\d+))?)?/g;

export function findFileLinksInLine(line: string): ParsedFileLink[] {
  const results: ParsedFileLink[] = [];
  FILE_LINK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FILE_LINK_RE.exec(line)) !== null) {
    const raw = match[0];
    const colonIdx = raw.indexOf(':');
    const filePath = colonIdx === -1 ? raw : raw.slice(0, colonIdx);
    const lineNum = match[1] ? Number.parseInt(match[1], 10) : 1;
    const colNum = match[2] ? Number.parseInt(match[2], 10) : 1;
    results.push({
      raw,
      filePath,
      line: Number.isFinite(lineNum) && lineNum > 0 ? lineNum : 1,
      column: Number.isFinite(colNum) && colNum > 0 ? colNum : 1,
      startIndex: match.index,
      length: raw.length,
    });
  }
  return results;
}

export function resolveCandidateFile(rawPath: string, baseCwd?: string): string | undefined {
  let target = rawPath.trim();
  if (!target) {
    return undefined;
  }
  if (target.startsWith('~/')) {
    const home = process.env.HOME;
    if (home) {
      target = path.join(home, target.slice(2));
    }
  }

  const candidates: string[] = [];
  if (path.isAbsolute(target)) {
    candidates.push(target);
  } else {
    if (baseCwd) {
      candidates.push(path.resolve(baseCwd, target));
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      candidates.push(path.resolve(folder.uri.fsPath, target));
    }
  }

  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // keep trying
    }
  }
  return undefined;
}

export async function openResolvedFile(
  rawPath: string,
  line = 1,
  column = 1,
  baseCwd?: string
): Promise<boolean> {
  const resolved = resolveCandidateFile(rawPath, baseCwd);
  if (!resolved) {
    return false;
  }
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(resolved));
  const pos = new vscode.Position(Math.max(0, line - 1), Math.max(0, column - 1));
  await vscode.window.showTextDocument(doc, {
    viewColumn: vscode.ViewColumn.One,
    selection: new vscode.Range(pos, pos),
    preserveFocus: false,
  });
  return true;
}

export function formatUriAsReference(uri: vscode.Uri, baseCwd?: string): string {
  const fsPath = uri.fsPath;
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (workspaceFolder) {
    const rel = path.relative(workspaceFolder.uri.fsPath, fsPath);
    if (rel && !rel.startsWith('..')) {
      return `@${rel}`;
    }
  }
  if (baseCwd) {
    const rel = path.relative(baseCwd, fsPath);
    if (rel && !rel.startsWith('..')) {
      return `@${rel}`;
    }
  }
  return `@${fsPath}`;
}
