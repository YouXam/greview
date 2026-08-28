import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type {
  Callback,
  CallbackResult,
  CliResult,
  DiffTarget,
  RepoInfo,
  Side,
  Thread,
} from '@greview/protocol';

const TIMEOUT_MS = 20_000;
/** Enough for a hook to finish; the CLI kills each one after a minute. */
const HOOK_TIMEOUT_MS = 150_000;

interface Launcher {
  command: string;
  prefix: string[];
  label: string;
}

export class CliError extends Error {}

/** Thin client over the `greview` binary, which is the only writer of the database. */
export class Cli {
  private launcher: Launcher | null = null;
  private probe: Promise<Launcher> | null = null;

  constructor(private readonly extensionPath: string) {}

  /** Forget the cached launcher after `greview.cliPath` changes. */
  reset(): void {
    this.launcher = null;
    this.probe = null;
  }

  private candidates(): Launcher[] {
    const out: Launcher[] = [];
    const configured = vscode.workspace.getConfiguration('greview').get<string>('cliPath', '').trim();
    if (configured) out.push({ command: configured, prefix: [], label: `greview.cliPath (${configured})` });
    out.push({ command: 'greview', prefix: [], label: 'greview on PATH' });
    const bundled = join(this.extensionPath, 'dist', 'greview-cli.mjs');
    if (existsSync(bundled)) {
      out.push({ command: 'node', prefix: [bundled], label: 'bundled CLI via node' });
    }
    return out;
  }

  private async resolveLauncher(): Promise<Launcher> {
    if (this.launcher) return this.launcher;
    if (this.probe) return this.probe;
    this.probe = (async () => {
      const tried: string[] = [];
      for (const candidate of this.candidates()) {
        try {
          await this.exec(candidate, ['--version'], undefined);
          this.launcher = candidate;
          return candidate;
        } catch (e) {
          tried.push(`${candidate.label}: ${(e as Error).message.split('\n')[0]}`);
        }
      }
      this.probe = null;
      throw new CliError(
        `could not run the greview CLI. Tried:\n${tried.join('\n')}\n` +
          'Install it with `npm i -g greview-cli`, or set `greview.cliPath`.',
      );
    })();
    return this.probe;
  }

  private exec(
    launcher: Launcher,
    args: string[],
    cwd: string | undefined,
    timeout = TIMEOUT_MS,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        launcher.command,
        [...launcher.prefix, ...args],
        { cwd, timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => {
          // A non-zero exit still carries a JSON error payload on stdout.
          if (error && !stdout) {
            reject(new CliError(stderr.trim() || error.message));
            return;
          }
          resolve(stdout);
        },
      );
    });
  }

  private async run<T>(cwd: string, args: string[], timeout?: number): Promise<T> {
    const launcher = await this.resolveLauncher();
    const stdout = await this.exec(launcher, [...args, '--json', '--cwd', cwd], cwd, timeout);
    let parsed: CliResult<T>;
    try {
      parsed = JSON.parse(stdout) as CliResult<T>;
    } catch {
      throw new CliError(`unexpected CLI output: ${stdout.slice(0, 400)}`);
    }
    if (!parsed.ok) throw new CliError(parsed.error);
    return parsed.data;
  }

  private authorArgs(): string[] {
    const author = vscode.workspace.getConfiguration('greview').get<string>('author', '').trim();
    return author ? ['--author', author] : [];
  }

  repo(cwd: string): Promise<RepoInfo> {
    return this.run<RepoInfo>(cwd, ['repo']);
  }

  list(root: string, includeResolved: boolean): Promise<Thread[]> {
    return this.run<Thread[]>(root, includeResolved ? ['list', '--all'] : ['list']);
  }

  add(
    root: string,
    input: { filePath: string; side: Side; target: DiffTarget; start: number; end: number; body: string },
  ): Promise<Thread> {
    return this.run<Thread>(root, [
      'add',
      '--file',
      input.filePath,
      '--line',
      input.start === input.end ? String(input.start) : `${input.start}-${input.end}`,
      '--side',
      input.side,
      '--target',
      input.target,
      '-m',
      input.body,
      ...this.authorArgs(),
    ]);
  }

  reply(root: string, id: number, body: string): Promise<Thread> {
    return this.run<Thread>(root, ['reply', String(id), '-m', body, ...this.authorArgs()]);
  }

  editComment(root: string, commentId: number, body: string): Promise<Thread> {
    return this.run<Thread>(root, ['edit', String(commentId), '-m', body, ...this.authorArgs()]);
  }

  setResolved(root: string, id: number, resolved: boolean): Promise<Thread> {
    return this.run<Thread>(root, [resolved ? 'resolve' : 'unresolve', String(id), ...this.authorArgs()]);
  }

  callbacks(root: string): Promise<Callback[]> {
    return this.run<Callback[]>(root, ['onsubmit', 'list']);
  }

  /** The CLI allows each hook up to a minute. */
  runCallbacks(root: string): Promise<CallbackResult[]> {
    return this.run<CallbackResult[]>(root, ['onsubmit', 'run'], HOOK_TIMEOUT_MS);
  }

  clearCallbacks(root: string): Promise<{ removed: number }> {
    return this.run<{ removed: number }>(root, ['onsubmit', 'clear']);
  }

  remove(root: string, id: number): Promise<unknown> {
    return this.run<unknown>(root, ['rm', String(id)]);
  }
}
