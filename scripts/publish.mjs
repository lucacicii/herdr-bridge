import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return;
  }
  const content = readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) {
      continue;
    }
    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && !process.env[key]) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(join(root, '.env.local'));

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const vsixPath = join(root, 'dist', `${pkg.name}-${pkg.version}.vsix`);

const targetArg = process.argv.find((a) => a.startsWith('--target='));
const target = targetArg ? targetArg.slice('--target='.length) : 'all';
const shouldBuild = process.argv.includes('--build');

if (!['vscode', 'openvsx', 'all'].includes(target)) {
  throw new Error(`Invalid --target=${target}. Expected vscode, openvsx, or all.`);
}

if (shouldBuild || !existsSync(vsixPath)) {
  execFileSync('pnpm', ['run', 'package'], { cwd: root, stdio: 'inherit', env: process.env });
}

const wantsVscode = target === 'vscode' || target === 'all';
const wantsOpenVsx = target === 'openvsx' || target === 'all';

if (wantsVscode && !process.env.VSCE_PAT) {
  console.error(
    '\n[Error] Missing VSCE_PAT for VS Code Marketplace.\n' +
      'Create an Azure DevOps PAT (Marketplace -> Manage) and set VSCE_PAT in your shell or .env.local (see .env.example).\n'
  );
  process.exit(1);
}

if (wantsOpenVsx && !process.env.OVSX_PAT) {
  console.error(
    '\n[Error] Missing OVSX_PAT for Open VSX Registry.\n' +
      'Create a token at https://open-vsx.org/user-settings/tokens and set OVSX_PAT in your shell or .env.local (see .env.example).\n'
  );
  process.exit(1);
}

if (wantsVscode) {
  console.log(`\nPublishing ${vsixPath} to VS Code Marketplace (${pkg.publisher}.${pkg.name})...`);
  execFileSync(
    'pnpm',
    ['exec', 'vsce', 'publish', '--packagePath', vsixPath, '--pat', process.env.VSCE_PAT],
    {
      cwd: root,
      stdio: 'inherit',
      env: process.env,
    }
  );
}

if (wantsOpenVsx) {
  console.log(`\nPublishing ${vsixPath} to Open VSX (${pkg.publisher}.${pkg.name})...`);
  execFileSync(
    'pnpm',
    ['exec', 'ovsx', 'publish', vsixPath, '-p', process.env.OVSX_PAT],
    {
      cwd: root,
      stdio: 'inherit',
      env: process.env,
    }
  );
}
