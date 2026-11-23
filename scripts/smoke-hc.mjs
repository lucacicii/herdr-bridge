import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-smoke-'));
const outFile = path.join(tmpDir, 'smoke.mjs');

try {
  await esbuild.build({
    stdin: {
      contents: `
        import { HcClient } from './src/hc/client.ts';
        import { checkEnvironment } from './src/hc/detector.ts';

        const client = new HcClient();
        const env = await checkEnvironment(client);
        console.log('Env check:', JSON.stringify(env, null, 2));

        if (!env.daemon.running) {
          throw new Error('herdr-core daemon is not running at ' + env.daemon.socketPath);
        }

        const list = await client.listTerminals(false);
        console.log('Live terminals:', list.terminals.length);

        const doc = await client.docGet('herdr-app').catch(() => null);
        const spaces = Array.isArray(doc?.spaces) ? doc.spaces : [];
        console.log('Spaces:', spaces.length, spaces.map((s) => s.name));

        const events = await client.subscribeEvents();
        console.log('Subscribed events channel:', events.channel, 'seq:', events.initial.seq);
        events.close();
      `,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile: outFile,
  });

  await import(pathToFileURL(outFile).href);
  console.log('Smoke test PASSED.');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
