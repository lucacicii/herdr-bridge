import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const outPath = join(root, 'dist', `${pkg.name}-${pkg.version}.vsix`);

execFileSync(
  'pnpm',
  ['exec', 'vsce', 'package', '--no-dependencies', '--out', outPath],
  {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  }
);

const sizeKb = (statSync(outPath).size / 1024).toFixed(1);
console.log(`\nPackaged unified VSIX: ${outPath} (${sizeKb} KB)`);
console.log(`Extension ID: ${pkg.publisher}.${pkg.name}`);
