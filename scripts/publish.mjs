import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
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

if (target === 'vscode' || target === 'all') {
  console.log(`\nPublishing ${vsixPath} to VS Code Marketplace (${pkg.publisher}.${pkg.name})...`);
  execFileSync('pnpm', ['exec', 'vsce', 'publish', '--packagePath', vsixPath], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
}

if (target === 'openvsx' || target === 'all') {
  console.log(`\nPublishing ${vsixPath} to Open VSX (${pkg.publisher}.${pkg.name})...`);
  execFileSync('pnpm', ['exec', 'ovsx', 'publish', vsixPath], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
}
