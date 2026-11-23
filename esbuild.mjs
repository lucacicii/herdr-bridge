import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const extConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info',
};

const webviewConfig = {
  entryPoints: ['src/webview/terminal.ts'],
  bundle: true,
  outfile: 'dist/webview/terminal.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  sourcemap: true,
  logLevel: 'info',
};

if (watch) {
  const [extCtx, webCtx] = await Promise.all([
    esbuild.context(extConfig),
    esbuild.context(webviewConfig),
  ]);
  await Promise.all([extCtx.watch(), webCtx.watch()]);
  console.log('[esbuild] watching extension and webview...');
} else {
  await Promise.all([esbuild.build(extConfig), esbuild.build(webviewConfig)]);
}
