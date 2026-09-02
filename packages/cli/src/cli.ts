import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { splitLines } from './anchor.ts';
import {
  branchName,
  findRepo,
  GitError,
  headSha,
  hunkHeaderAt,
  readVersion,
  toRepoPath,
  versionFor,
  type Repo,
} from './git.ts';
import { dbPathFor, Store } from './store.ts';
import { commandHelp, globalHelp } from './help.ts';
import { resolveThread, syncAll, syncThread, toThread } from './sync.ts';
import { bold, cyan, dim, threadDetail, threadLine, yellow } from './format.ts';
import type {
  AuthorKind,
  Callback,
  CallbackResult,
  DiffTarget,
  RepoInfo,
  Side,
  Stats,
  Thread,
} from './protocol.ts';

function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version?: unknown;
  };
  if (typeof pkg.version !== 'string' || pkg.version === '') {
    throw new Error('greview package version is missing');
  }
  return pkg.version;
}

const VERSION = packageVersion();

class UsageError extends Error {}

const SKILL_INSTALL_ARGS = [
  '--yes',
  'skills',
  'add',
  'YouXam/greview',
  '--skill',
  'greview',
];
const EXTENSION_ID = 'youxam.greview';
const MARKETPLACE_URL = `https://marketplace.visualstudio.com/items?itemName=${EXTENSION_ID}`;

function fail(message: string): never {
  throw new UsageError(message);
}

function runInstaller(executable: string, args: string[], missingHelp: string): number {
  const result = spawnSync(executable, args, { stdio: 'inherit' });
  if (result.error) {
    process.stderr.write(`greview: could not start ${executable}: ${result.error.message}\n${missingHelp}\n`);
    return 1;
  }
  if (result.signal) {
    process.stderr.write(`greview: ${executable} stopped by ${result.signal}\n`);
    return 1;
  }
  return result.status ?? 1;
}

function installSkill(): number {
  const executable = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  return runInstaller(
    executable,
    SKILL_INSTALL_ARGS,
    'Install Node.js with npm, then run `greview setup skill` again.',
  );
}

function installExtension(): number {
  const executable = process.platform === 'win32' ? 'code.cmd' : 'code';
  return runInstaller(
    executable,
    ['--install-extension', EXTENSION_ID],
    `Install from ${MARKETPLACE_URL}, or add the VS Code \`code\` command to PATH.`,
  );
}

type SetupComponent = 'skill' | 'extension';

function installComponents(components: SetupComponent[]): number {
  let status = 0;
  for (const component of components) {
    const result = component === 'skill' ? installSkill() : installExtension();
    if (result !== 0) status = result;
  }
  return status;
}

async function interactiveSetup(): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let components: SetupComponent[] | null = null;
  try {
    process.stdout.write(
      'greview setup\n\n' +
        '  1) Agent skill\n' +
        '  2) VS Code extension\n' +
        '  3) Both\n\n',
    );
    const answer = (await rl.question('Select components [1-3, q to cancel]: ')).trim().toLowerCase();
    if (answer === '1' || answer === 'skill') components = ['skill'];
    else if (answer === '2' || answer === 'extension') components = ['extension'];
    else if (answer === '3' || answer === 'both') components = ['skill', 'extension'];
    else if (answer === 'q' || answer === 'quit' || answer === '') return 0;
    else {
      process.stderr.write(`greview: unknown setup selection "${answer}"\n`);
      return 2;
    }
  } finally {
    rl.close();
  }
  if (components === null) return 0;
  return installComponents(components);
}

function cmdSetup(positionals: string[]): number | Promise<number> {
  if (positionals.length > 2) {
    process.stderr.write('greview: usage: greview setup [skill|extension]\n');
    return 2;
  }
  const component = positionals[1];
  if (component === undefined) return interactiveSetup();
  if (component === 'skill' || component === 'extension') return installComponents([component]);
  process.stderr.write(`greview: unknown setup component "${component}" (skill or extension)\n`);
  return 2;
}

interface Ctx {
  repo: Repo;
  store: Store;
  json: boolean;
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      cwd: { type: 'string' },
      json: { type: 'boolean', default: false },
      all: { type: 'boolean', default: false },
      resolved: { type: 'boolean', default: false },
      file: { type: 'string' },
      line: { type: 'string' },
      side: { type: 'string' },
      target: { type: 'string' },
      message: { type: 'string', short: 'm' },
      author: { type: 'string' },
      agent: { type: 'boolean', default: false },
      by: { type: 'string' },
      events: { type: 'boolean', default: false },
      'no-sync': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });
}

type Values = ReturnType<typeof parse>['values'];

/** A name for the agent running this command, from whatever its harness exported. */
function agentName(): string | null {
  // Agent harnesses may append instance metadata; the leading segment names the tool.
  const declared = process.env.AI_AGENT?.trim();
  if (declared) {
    const head = declared.split('_')[0]?.trim();
    if (head) return head;
  }
  if (process.env.CLAUDECODE === '1') return 'claude-code';
  return null;
}

/** True when a coding agent is running this command. */
function looksLikeAgent(): boolean {
  return process.env.AI_AGENT !== undefined || process.env.CLAUDECODE === '1';
}

/**
 * Who is writing, and whether they are a person. An agent is never attributed to
 * `git config user.name`, which is the reviewer's identity.
 */
function authorOf(repo: Repo, values: Values): { author: string; kind: AuthorKind } {
  const declaredKind = process.env.GREVIEW_AUTHOR_KIND;
  const kind: AuthorKind =
    values.agent || declaredKind === 'agent' || (declaredKind !== 'human' && looksLikeAgent())
      ? 'agent'
      : 'human';

  const explicit = (values.author ?? process.env.GREVIEW_AUTHOR)?.trim();
  if (explicit) return { author: explicit, kind };

  if (kind === 'agent') {
    const inferred = agentName();
    if (inferred) return { author: inferred, kind };
    return fail(
      'an agent must name itself: pass --author <name> (for example claude-code or codex), ' +
        'or set GREVIEW_AUTHOR. git config user.name belongs to the human reviewer and will ' +
        'not be used for an agent comment.',
    );
  }

  const r = spawnSync('git', ['config', 'user.name'], { cwd: repo.root, encoding: 'utf8' });
  return { author: (r.stdout ?? '').trim() || 'unknown', kind };
}

function messageOf(values: Values): string {
  const raw = values.message;
  if (raw === undefined) fail('a comment body is required: -m "<text>" (or -m - to read stdin)');
  const body = raw === '-' ? readFileSync(0, 'utf8') : raw;
  if (body.trim() === '') fail('the comment body is empty');
  return body.replace(/\s+$/, '');
}

function parseSide(v: string | undefined): Side {
  if (v === undefined) return 'new';
  if (v === 'new' || v === 'old') return v;
  return fail(`--side must be new or old, got ${v}`);
}

function parseTarget(v: string | undefined, dflt: DiffTarget | null): DiffTarget {
  if (v === undefined) {
    if (dflt === null) return fail('--target is required');
    return dflt;
  }
  if (v === 'worktree' || v === 'index' || v === 'head') return v;
  return fail(`--target must be worktree, index or head, got ${v}`);
}

function parseRange(v: string | undefined): { start: number; end: number } {
  if (v === undefined) fail('--line <n|n-m> is required');
  const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(v.trim());
  if (!m) fail(`--line must look like 12 or 12-18, got ${v}`);
  const start = Number(m[1]);
  const end = m[2] === undefined ? start : Number(m[2]);
  if (start < 1) fail('line numbers start at 1');
  if (end < start) fail(`--line range is inverted: ${v}`);
  return { start, end };
}

function threadIdOf(positionals: string[]): number {
  const raw = positionals[1];
  if (raw === undefined) fail('a thread id is required');
  const id = Number(raw.replace(/^#/, ''));
  if (!Number.isInteger(id) || id < 1) fail(`not a thread id: ${raw}`);
  return id;
}

function loadThread(ctx: Ctx, id: number, opts: { sync: boolean; events: boolean }): Thread {
  const row = ctx.store.thread(id);
  if (row === null) fail(`no thread #${id}`);
  const r = opts.sync
    ? ctx.store.transaction(() => syncThread(ctx.repo, ctx.store, row))
    : resolveThread(ctx.repo, ctx.store, row);
  const fresh = ctx.store.thread(id)!;
  return toThread(ctx.store, fresh, r, { events: opts.events });
}

function collect(ctx: Ctx, values: Values): Thread[] {
  const sync = values['no-sync'] !== true;
  const resolutions = sync ? syncAll(ctx.repo, ctx.store) : null;
  const target = values.target === undefined ? null : parseTarget(values.target, null);
  const file = values.file === undefined ? null : toRepoPath(ctx.repo, values.file, cwdOf(values));

  const out: Thread[] = [];
  for (const row of ctx.store.threads()) {
    if (values.resolved && row.status !== 'resolved') continue;
    if (!values.resolved && !values.all && row.status !== 'open') continue;
    if (target !== null && row.target !== target) continue;
    if (file !== null && row.file_path !== file) continue;
    const r = resolutions?.get(row.id) ?? resolveThread(ctx.repo, ctx.store, row);
    out.push(toThread(ctx.store, row, r, { events: values.events }));
  }
  // Threads needing attention sort first.
  const weight = (t: Thread) =>
    t.status === 'resolved' ? 4 : t.current.drift === 'changed' || t.current.drift === 'orphaned' ? 1 : 3;
  return out.sort((a, b) => weight(a) - weight(b) || a.filePath.localeCompare(b.filePath) || a.id - b.id);
}

function cwdOf(values: Values): string {
  return values.cwd ?? process.env.GREVIEW_CWD ?? process.cwd();
}

function emit(ctx: Ctx | null, json: boolean, data: unknown, human: () => void): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: true, data }, null, 2)}\n`);
  } else {
    human();
  }
  ctx?.store.close();
}

function cmdRepo(ctx: Ctx): void {
  const info: RepoInfo = {
    root: ctx.repo.root,
    gitDir: ctx.repo.gitDir,
    dbPath: dbPathFor(ctx.repo),
    head: headSha(ctx.repo),
    branch: branchName(ctx.repo),
  };
  emit(ctx, ctx.json, info, () => {
    console.log(`${dim('root  ')} ${info.root}`);
    console.log(`${dim('gitdir')} ${info.gitDir}`);
    console.log(`${dim('db    ')} ${info.dbPath}`);
    console.log(`${dim('branch')} ${info.branch ?? '(detached)'} ${dim(info.head?.slice(0, 12) ?? '')}`);
  });
}

function cmdAdd(ctx: Ctx, values: Values): void {
  if (values.file === undefined) fail('--file <path> is required');
  const filePath = toRepoPath(ctx.repo, values.file, cwdOf(values));
  const side = parseSide(values.side);
  const target = parseTarget(values.target, 'worktree');
  const { start, end } = parseRange(values.line);
  const body = messageOf(values);
  const { author, kind } = authorOf(ctx.repo, values);

  const version = versionFor(target, side);
  const content = readVersion(ctx.repo, version, filePath);
  if (content === null) {
    fail(`${filePath} does not exist in the ${version} version, so there is nothing to anchor to`);
  }
  if (content.includes('\0')) fail(`${filePath} looks binary; only text files can be commented on`);
  const total = splitLines(content).length;
  if (total === 0) fail(`${filePath} is empty in the ${version} version`);
  if (start > total) fail(`${filePath} has ${total} lines in the ${version} version; --line ${start} is past the end`);
  const clampedEnd = Math.min(end, total);

  const hunkHeader = hunkHeaderAt(ctx.repo, target, side, filePath, start);
  const id = ctx.store.transaction(() =>
    ctx.store.createThread({
      filePath,
      side,
      target,
      content,
      start,
      end: clampedEnd,
      hunkHeader,
      author,
      authorKind: kind,
      body,
    }),
  );
  const thread = loadThread(ctx, id, { sync: true, events: true });
  emit(ctx, ctx.json, thread, () => {
    console.log(`${bold('created')} ${cyan(`#${id}`)} ${thread.ref}`);
    if (hunkHeader === null) {
      console.log(
        yellow('note: those lines are not part of that diff — the comment is anchored to them anyway'),
      );
    }
  });
}

function cmdList(ctx: Ctx, values: Values): void {
  const threads = collect(ctx, values);
  emit(ctx, ctx.json, threads, () => {
    if (threads.length === 0) {
      console.log(dim(values.resolved ? 'no resolved threads' : 'no open threads'));
      return;
    }
    let file = '';
    for (const t of threads) {
      if (t.filePath !== file) {
        file = t.filePath;
        console.log(`\n${bold(file)}`);
      }
      console.log(threadLine(t));
      for (const note of t.current.notes) console.log(`    ${yellow('•')} ${note.text}`);
    }
    console.log('');
  });
}

function cmdShow(ctx: Ctx, values: Values, positionals: string[]): void {
  const thread = loadThread(ctx, threadIdOf(positionals), {
    sync: values['no-sync'] !== true,
    events: true,
  });
  emit(ctx, ctx.json, thread, () => console.log(threadDetail(thread)));
}

function cmdReply(ctx: Ctx, values: Values, positionals: string[]): void {
  const id = threadIdOf(positionals);
  if (ctx.store.thread(id) === null) fail(`no thread #${id}`);
  const body = messageOf(values);
  const { author, kind } = authorOf(ctx.repo, values);
  ctx.store.addComment(id, author, kind, body);
  const thread = loadThread(ctx, id, { sync: true, events: true });
  emit(ctx, ctx.json, thread, () => console.log(`${bold('replied to')} ${cyan(`#${id}`)}`));
}

function cmdEdit(ctx: Ctx, values: Values, positionals: string[]): void {
  const raw = positionals[1];
  if (raw === undefined) fail('a comment id is required (see comments[].id in `show --json`)');
  const commentId = Number(raw.replace(/^#/, ''));
  if (!Number.isInteger(commentId) || commentId < 1) fail(`not a comment id: ${raw}`);
  const body = messageOf(values);
  const threadId = ctx.store.editComment(commentId, body);
  if (threadId === null) fail(`no comment #${commentId}`);
  const thread = loadThread(ctx, threadId, { sync: true, events: true });
  emit(ctx, ctx.json, thread, () =>
    console.log(`${bold('edited')} comment ${cyan(`#${commentId}`)} ${dim(`in thread #${threadId}`)}`),
  );
}

function cmdSetStatus(ctx: Ctx, values: Values, positionals: string[], resolved: boolean): void {
  const id = threadIdOf(positionals);
  if (ctx.store.thread(id) === null) fail(`no thread #${id}`);
  const by = values.by ?? authorOf(ctx.repo, values).author;
  ctx.store.setStatus(id, resolved ? 'resolved' : 'open', by);
  const thread = loadThread(ctx, id, { sync: false, events: true });
  emit(ctx, ctx.json, thread, () =>
    console.log(`${bold(resolved ? 'resolved' : 'reopened')} ${cyan(`#${id}`)} ${dim(`by ${by}`)}`),
  );
}

function cmdRm(ctx: Ctx, positionals: string[]): void {
  const id = threadIdOf(positionals);
  if (!ctx.store.deleteThread(id)) fail(`no thread #${id}`);
  emit(ctx, ctx.json, { id, deleted: true }, () => console.log(`${bold('deleted')} ${cyan(`#${id}`)}`));
}

function cmdSync(ctx: Ctx): void {
  const before = new Map(ctx.store.threads().map((r) => [r.id, r.drift]));
  const resolutions = syncAll(ctx.repo, ctx.store);
  const changed: Array<{ id: number; from: string | null; to: string }> = [];
  for (const [id, r] of resolutions) {
    const from = before.get(id) ?? null;
    if (from !== r.drift) changed.push({ id, from, to: r.drift });
  }
  emit(ctx, ctx.json, { checked: resolutions.size, changed }, () => {
    console.log(`${bold('checked')} ${resolutions.size} thread(s)`);
    for (const c of changed) console.log(`  ${cyan(`#${c.id}`)} ${c.from ?? 'new'} → ${c.to}`);
  });
}

const CALLBACK_TIMEOUT_MS = 60_000;

function toCallback(row: { name: string; command: string; created_at: string }): Callback {
  return { name: row.name, command: row.command, createdAt: row.created_at };
}

/** Runs one hook through the shell, with no arguments. */
function runCallback(cwd: string, callback: Callback): Promise<CallbackResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(callback.command, {
      cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, CALLBACK_TIMEOUT_MS);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({
        ...callback,
        code: null,
        signal: null,
        timedOut,
        stdout,
        stderr: stderr || e.message,
        durationMs: Date.now() - started,
      });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        ...callback,
        code,
        signal: signal ?? null,
        timedOut,
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        durationMs: Date.now() - started,
      });
    });
  });
}

function cmdOnsubmit(ctx: Ctx, values: Values, positionals: string[]): void | Promise<void> {
  const sub = positionals[1] ?? 'list';
  switch (sub) {
    case 'list': {
      const list = ctx.store.callbacks().map(toCallback);
      return emit(ctx, ctx.json, list, () => {
        if (list.length === 0) {
          console.log(dim('no submit hooks in this worktree'));
          return;
        }
        for (const c of list) console.log(`${cyan(c.name)}  ${c.command}`);
      });
    }
    case 'add': {
      const name = positionals[2];
      const command = positionals[3];
      if (name === undefined || name.trim() === '') fail('a hook name is required');
      if (command === undefined || command.trim() === '') {
        fail('a command is required: greview onsubmit add <name> "<command>"');
      }
      ctx.store.putCallback(name, command);
      const list = ctx.store.callbacks().map(toCallback);
      return emit(ctx, ctx.json, list, () => console.log(`${bold('added')} hook ${cyan(name)}`));
    }
    case 'delete':
    case 'rm': {
      const name = positionals[2];
      if (name === undefined) fail('which hook? greview onsubmit delete <name>');
      if (!ctx.store.deleteCallback(name)) fail(`no hook named ${name}`);
      const list = ctx.store.callbacks().map(toCallback);
      return emit(ctx, ctx.json, list, () => console.log(`${bold('deleted')} hook ${cyan(name)}`));
    }
    case 'clear': {
      const removed = ctx.store.clearCallbacks();
      return emit(ctx, ctx.json, { removed }, () =>
        console.log(`${bold('cleared')} ${removed} hook(s)`),
      );
    }
    case 'run': {
      const list = ctx.store.callbacks().map(toCallback);
      const root = ctx.repo.root;
      const json = ctx.json;
      return Promise.all(list.map((c) => runCallback(root, c))).then((results) => {
        const failed = results.filter((r) => r.code !== 0);
        if (json) {
          process.stdout.write(`${JSON.stringify({ ok: true, data: results }, null, 2)}\n`);
        } else if (results.length === 0) {
          console.log(dim('no submit hooks in this worktree'));
        } else {
          for (const r of results) {
            const status = r.timedOut
              ? yellow('timed out')
              : r.code === 0
                ? bold('ok')
                : `${yellow('exit')} ${r.code ?? r.signal}`;
            console.log(`${cyan(r.name)} ${status} ${dim(`${r.durationMs}ms`)}`);
            for (const line of [...r.stdout.split('\n'), ...r.stderr.split('\n')]) {
              if (line.trim() !== '') console.log(`  ${dim(line)}`);
            }
          }
        }
        if (failed.length > 0) process.exitCode = 1;
      });
    }
    default:
      return fail(`unknown onsubmit subcommand "${sub}" (list, add, delete, clear, run)`);
  }
}

function cmdStats(ctx: Ctx): void {
  const resolutions = syncAll(ctx.repo, ctx.store);
  const stats: Stats = { open: 0, resolved: 0, changed: 0, orphaned: 0 };
  for (const row of ctx.store.threads()) {
    if (row.status === 'resolved') {
      stats.resolved++;
      continue;
    }
    stats.open++;
    const drift = resolutions.get(row.id)?.drift ?? row.drift;
    if (drift === 'changed') stats.changed++;
    if (drift === 'orphaned') stats.orphaned++;
  }
  emit(ctx, ctx.json, stats, () =>
    console.log(
      `${stats.open} open, ${stats.resolved} resolved, ${stats.changed} changed under you, ${stats.orphaned} orphaned`,
    ),
  );
}

function printHelp(parts: string[]): number {
  if (parts.length === 0) {
    process.stdout.write(globalHelp(VERSION));
    return 0;
  }
  const text = commandHelp(parts);
  if (text === null) {
    process.stderr.write(`greview: no help topic for "${parts.join(' ')}"\nTry: greview help\n`);
    return 2;
  }
  process.stdout.write(text);
  return 0;
}

/**
 * SQLITE_BUSY surviving the in-connection busy handler means a filesystem where
 * that handler cannot do its job (some network mounts). A failed command has, by
 * SQLite's contract, committed nothing, so re-running it whole is safe.
 */
const BUSY_ATTEMPTS = 4;

function isBusy(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const errcode = (e as { errcode?: unknown }).errcode;
  if (typeof errcode === 'number') return (errcode & 0xff) === 5;
  return e.message === 'database is locked';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(argv: string[]): Promise<number> {
  let values: Values;
  let positionals: string[];
  try {
    ({ values, positionals } = parse(argv));
  } catch (e) {
    process.stderr.write(`greview: ${(e as Error).message}\n`);
    return 2;
  }

  const command = positionals[0] ?? (values.version ? 'version' : 'help');
  if (command === 'help') return printHelp(positionals.slice(1));
  if (values.help) return printHelp(positionals);
  if (command === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (command === 'setup') return cmdSetup(positionals);

  for (let attempt = 1; ; attempt++) {
    let ctx: Ctx | null = null;
    try {
      const repo = findRepo(cwdOf(values));
      ctx = { repo, store: new Store(repo), json: values.json === true };
        switch (command) {
        case 'repo':
          cmdRepo(ctx);
          break;
        case 'add':
          cmdAdd(ctx, values);
          break;
        case 'list':
        case 'ls':
          cmdList(ctx, values);
          break;
        case 'show':
          cmdShow(ctx, values, positionals);
          break;
        case 'reply':
          cmdReply(ctx, values, positionals);
          break;
        case 'edit':
          cmdEdit(ctx, values, positionals);
          break;
        case 'resolve':
          cmdSetStatus(ctx, values, positionals, true);
          break;
        case 'unresolve':
        case 'reopen':
          cmdSetStatus(ctx, values, positionals, false);
          break;
        case 'rm':
        case 'delete':
          cmdRm(ctx, positionals);
          break;
        case 'sync':
          cmdSync(ctx);
          break;
        case 'stats':
          cmdStats(ctx);
          break;
        case 'onsubmit': {
          const pending = cmdOnsubmit(ctx, values, positionals);
          if (pending) return pending.then(() => 0);
          break;
        }
        default:
          process.stderr.write(`greview: unknown command "${command}"\nTry: greview help\n`);
          return 2;
      }
      return 0;
    } catch (e) {
      if (isBusy(e) && attempt < BUSY_ATTEMPTS) {
        // Brief, jittered: the colliding writer is another short-lived greview.
        await sleep(attempt * 150 + Math.random() * 100);
        continue;
      }
      const message = e instanceof Error ? e.message : String(e);
      if (values.json) {
        process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
      } else {
        process.stderr.write(`greview: ${message}\n`);
      }
      return e instanceof UsageError ? 2 : e instanceof GitError ? 3 : 1;
    } finally {
      try {
        ctx?.store.close();
      } catch {
        // Already closed by emit() on the success path.
      }
    }
  }
}

void main(process.argv.slice(2)).then(
  (code) => {
    // `onsubmit run` is the only command that sets its own exit code on failure;
    // a clean resolution means success.
    if (process.exitCode === undefined || process.exitCode === 0) process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`greview: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  },
);
