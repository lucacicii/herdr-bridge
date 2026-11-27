import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

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

export function findHerdrAppBinary(): string | undefined {
  const explicit = process.env.HERDR_APP_BIN?.trim();
  if (explicit) {
    if (isExecutableFile(explicit)) {
      return explicit;
    }
    return undefined;
  }

  const pathEnv = process.env.PATH ?? '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = path.join(dir, 'herdr-app');
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }

  const home = os.homedir();
  const candidates = [
    path.join(home, '.local', 'bin', 'herdr-app'),
    '/Applications/Herdr.app/Contents/MacOS/Herdr',
    '/usr/local/bin/herdr-app',
  ];
  for (const candidate of candidates) {
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export class HerdrAppClient {
  private cachedPath: string | undefined;
  private lookedUp = false;

  getPath(refresh = false): string | undefined {
    if (!this.lookedUp || refresh) {
      this.lookedUp = true;
      this.cachedPath = findHerdrAppBinary();
    }
    return this.cachedPath;
  }

  isAvailable(): boolean {
    return Boolean(this.getPath());
  }

  private async run(args: string[]): Promise<string> {
    const bin = this.getPath(true);
    if (!bin) {
      throw new Error('Herdr app CLI not found (install Herdr or set HERDR_APP_BIN)');
    }
    const { stdout } = await execFileAsync(bin, args, { timeout: 20000 });
    return stdout;
  }

  async doCommand(command: string, args: Record<string, string>): Promise<Record<string, unknown>> {
    const argv = ['do', command];
    for (const key of Object.keys(args).sort()) {
      argv.push(`--${key}`, args[key]);
    }
    const raw = await this.run(argv);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.error === 'string' && parsed.error) {
      throw new Error(parsed.error);
    }
    return parsed;
  }

  async createSpace(name: string, folder: string): Promise<string> {
    const args: Record<string, string> = { folder, focus: 'true' };
    if (name.trim()) {
      args.name = name.trim();
    }
    const result = await this.doCommand('space.new', args);
    const id = typeof result.space === 'string' ? result.space : '';
    if (!id) {
      throw new Error('herdr-app space.new returned no space id');
    }
    return id;
  }

  async renameSpace(spaceId: string, name: string): Promise<void> {
    if (!spaceId) {
      throw new Error('space id is required');
    }
    await this.doCommand('space.rename', { id: spaceId, name });
  }

}
