import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const publisher = pkg.publisher;
const vsixPath = join(root, 'dist', `${pkg.name}-${pkg.version}.vsix`);

if (!publisher || typeof publisher !== 'string') {
  throw new Error('package.json is missing publisher');
}

console.log(`1. Extension ID: ${publisher}.${pkg.name} v${pkg.version}`);

// 2. Check VS Code Marketplace publisher
const mpUrl = `https://marketplace.visualstudio.com/publishers/${publisher}`;
const mpRes = await fetch(mpUrl);
console.log(`2. VS Code Marketplace (${mpUrl}): HTTP ${mpRes.status}`);
if (mpRes.status !== 200) {
  throw new Error(`Publisher "${publisher}" not found on VS Code Marketplace (HTTP ${mpRes.status})`);
}

// 3. Check Open VSX namespace
const ovsxUrl = `https://open-vsx.org/api/${publisher}`;
const ovsxRes = await fetch(ovsxUrl);
const ovsxBody = await ovsxRes.text();
console.log(`3. Open VSX (${ovsxUrl}): HTTP ${ovsxRes.status}`);
if (ovsxRes.status !== 200) {
  throw new Error(`Namespace "${publisher}" not found on Open VSX (HTTP ${ovsxRes.status}): ${ovsxBody}`);
}
try {
  const parsed = JSON.parse(ovsxBody);
  console.log(`   Open VSX namespace verified: ${Boolean(parsed.verified)}`);
} catch {
  // ignore non-json
}

// 4. Verify unified VSIX exists and contains required bundled assets
if (!existsSync(vsixPath)) {
  throw new Error(`VSIX not found at ${vsixPath}. Run "pnpm run package" first.`);
}
const unzipList = execFileSync('unzip', ['-l', vsixPath], { encoding: 'utf8' });
const requiredEntries = [
  'extension/package.json',
  'extension/dist/extension.js',
  'extension/dist/webview/terminal.js',
  'extension/dist/webview/terminal.css',
  'extension/resources/herdr-icon.svg',
  'extension/LICENSE',
];
for (const entry of requiredEntries) {
  if (!unzipList.includes(entry)) {
    throw new Error(`VSIX is missing required file: ${entry}`);
  }
}
console.log(`4. Unified VSIX verified (${vsixPath}): all ${requiredEntries.length} required entries present.`);

// 5. Token status
const hasOvsxPat = Boolean(process.env.OVSX_PAT);
const hasVscePat = Boolean(process.env.VSCE_PAT);
console.log(`5. Tokens: OVSX_PAT=${hasOvsxPat ? 'set' : 'unset'}, VSCE_PAT=${hasVscePat ? 'set' : 'unset'}`);
if (hasVscePat) {
  execFileSync('pnpm', ['exec', 'vsce', 'verify-pat', publisher], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
}

console.log('\nPublish verification PASSED.');
