import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { defaultSocketPath, type HcClient } from './client';
import type { HcEnvStatus } from './types';

const execFileAsync = promisify(execFile);

function isExecutableFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return false;
    }
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function withLocalBinPath(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const localBin = path.join(os.homedir(), '.local', 'bin');
  const current = env.PATH ?? '';
  const sep = path.delimiter;
  const parts = current ? current.split(sep) : [];
  if (!parts.includes(localBin)) {
    return { ...env, PATH: current ? `${localBin}${sep}${current}` : localBin };
  }
  return env;
}

export function findHcBinary(): string | undefined {
  const pathEnv = process.env.PATH ?? '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = path.join(dir, 'hc');
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }

  const home = os.homedir();
  const fallbacks = [
    path.join(home, '.local', 'bin', 'hc'),
    path.join(home, 'bin', 'hc'),
    '/opt/homebrew/bin/hc',
    '/usr/local/bin/hc',
  ];
  for (const candidate of fallbacks) {
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export async function probeHcVersion(hcPath: string): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await execFileAsync(hcPath, ['--version'], {
      timeout: 1500,
      env: withLocalBinPath(),
    });
    const text = (stdout || stderr || '').trim();
    return text.split('\n')[0]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function checkEnvironment(client: HcClient): Promise<HcEnvStatus> {
  const hcPath = findHcBinary();
  const hcVersion = hcPath ? await probeHcVersion(hcPath) : undefined;
  const socketPath = client.getSocketPath();

  try {
    const status = await client.serverStatus(1500);
    return {
      hcCli: {
        installed: Boolean(hcPath),
        path: hcPath,
        version: hcVersion,
      },
      daemon: {
        running: true,
        socketPath,
        version: status.version,
        pid: status.pid,
        liveTerminals: status.live,
      },
    };
  } catch (err) {
    return {
      hcCli: {
        installed: Boolean(hcPath),
        path: hcPath,
        version: hcVersion,
      },
      daemon: {
        running: false,
        socketPath,
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

export async function startDaemon(hcPath: string): Promise<void> {
  await execFileAsync(hcPath, ['server', 'start'], {
    timeout: 10000,
    env: withLocalBinPath(),
  });
}

export async function ensureDaemonIfInstalled(client: HcClient): Promise<boolean> {
  if (client.getSocketPath() !== defaultSocketPath()) {
    return false;
  }
  try {
    await client.serverStatus(1200);
    return true;
  } catch {
    const hcPath = findHcBinary();
    if (!hcPath) {
      return false;
    }
    try {
      await startDaemon(hcPath);
      await client.serverStatus(2000);
      return true;
    } catch {
      return false;
    }
  }
}
