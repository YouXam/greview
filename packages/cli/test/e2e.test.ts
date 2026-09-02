import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  Callback,
  CallbackResult,
  CliResult,
  RepoInfo,
  Stats,
  Thread,
} from '../src/protocol.ts';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');
const scratch: string[] = [];

/**
 * The suite may well be run *by* an agent, and the CLI detects that from the
 * environment. Strip those markers so identity tests assert on what they pass in
 * rather than on who happens to be running them.
 */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  for (const key of ['AI_AGENT', 'CLAUDECODE', 'GREVIEW_AUTHOR', 'GREVIEW_AUTHOR_KIND']) {
    if (!(key in extra)) delete env[key];
  }
  return env;
}

after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
}

/** Runs the CLI from source so the test exercises argument parsing too. */
function run<T>(cwd: string, ...args: string[]): T {
  const r = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', CLI, ...args, '--json', '--cwd', cwd],
    { cwd, encoding: 'utf8', env: cleanEnv() },
  );
  const parsed = JSON.parse(r.stdout) as CliResult<T>;
  assert.equal(parsed.ok, true, `greview ${args.join(' ')} failed: ${parsed.ok ? '' : parsed.error}`);
  return (parsed as { ok: true; data: T }).data;
}

function runRaw(
  cwd: string,
  ...args: string[]
): { status: number; stdout: string; stderr: string } {
  return runRawEnv(cwd, {}, ...args);
}

function runRawEnv(
  cwd: string,
  env: Record<string, string>,
  ...args: string[]
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', CLI, ...args, '--json', '--cwd', cwd],
    { cwd, encoding: 'utf8', env: cleanEnv(env) },
  );
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function runRawInputEnv(
  cwd: string,
  input: string,
  env: Record<string, string>,
  ...args: string[]
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', CLI, ...args, '--cwd', cwd],
    { cwd, encoding: 'utf8', env: cleanEnv(env), input },
  );
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function runEnv<T>(cwd: string, env: Record<string, string>, ...args: string[]): T {
  const r = runRawEnv(cwd, env, ...args);
  const parsed = JSON.parse(r.stdout) as CliResult<T>;
  assert.equal(parsed.ok, true, `greview ${args.join(' ')} failed: ${parsed.ok ? '' : parsed.error}`);
  return (parsed as { ok: true; data: T }).data;
}

/** The human-readable output, which is what a reader actually sees. */
function runText(cwd: string, ...args: string[]): string {
  const r = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', CLI, ...args, '--cwd', cwd],
    { cwd, encoding: 'utf8', env: cleanEnv({ NO_COLOR: '1' }) },
  );
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ?? '';
}

function makeRepo(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'greview-test-'));
  scratch.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  writeFileSync(join(dir, 'a.txt'), `${lines.join('\n')}\n`);
  git(dir, 'add', 'a.txt');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

const base = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];

test('global help includes agent skill guidance and works outside a repository', () => {
  const dir = mkdtempSync(join(tmpdir(), 'greview-help-test-'));
  scratch.push(dir);
  const result = runRaw(dir, 'help');

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /greview setup skill/);
  assert.match(result.stdout, /npx --yes skills add YouXam\/greview --skill greview/);
  assert.match(result.stdout, /github\.com\/YouXam\/greview\/tree\/main\/skills\/greview/);
});

test('every command and nested subcommand has help outside a repository', () => {
  const dir = mkdtempSync(join(tmpdir(), 'greview-command-help-test-'));
  scratch.push(dir);
  const cases: Array<{ args: string[]; usage: RegExp }> = [
    { args: ['list'], usage: /Usage:\n  greview list/ },
    { args: ['show'], usage: /Usage:\n  greview show/ },
    { args: ['add'], usage: /Usage:\n  greview add/ },
    { args: ['reply'], usage: /Usage:\n  greview reply/ },
    { args: ['edit'], usage: /Usage:\n  greview edit/ },
    { args: ['resolve'], usage: /Usage:\n  greview resolve/ },
    { args: ['unresolve'], usage: /Usage:\n  greview unresolve/ },
    { args: ['rm'], usage: /Usage:\n  greview rm/ },
    { args: ['sync'], usage: /Usage:\n  greview sync/ },
    { args: ['stats'], usage: /Usage:\n  greview stats/ },
    { args: ['repo'], usage: /Usage:\n  greview repo/ },
    { args: ['setup'], usage: /Usage:\n  greview setup/ },
    { args: ['setup', 'skill'], usage: /Usage:\n  greview setup skill/ },
    { args: ['setup', 'extension'], usage: /Usage:\n  greview setup extension/ },
    { args: ['onsubmit'], usage: /Usage:\n  greview onsubmit/ },
    { args: ['onsubmit', 'list'], usage: /Usage:\n  greview onsubmit list/ },
    { args: ['onsubmit', 'add'], usage: /Usage:\n  greview onsubmit add/ },
    { args: ['onsubmit', 'delete'], usage: /Usage:\n  greview onsubmit delete/ },
    { args: ['onsubmit', 'clear'], usage: /Usage:\n  greview onsubmit clear/ },
    { args: ['onsubmit', 'run'], usage: /Usage:\n  greview onsubmit run/ },
    { args: ['help', 'help'], usage: /Usage:\n  greview help/ },
    { args: ['version'], usage: /Usage:\n  greview version/ },
  ];

  for (const item of cases) {
    const result = runRaw(dir, ...item.args, '--help');
    assert.equal(result.status, 0, `${item.args.join(' ')}: ${result.stderr}`);
    assert.match(result.stdout, item.usage, item.args.join(' '));
  }
});

test('help command matches command --help and rejects unknown topics', () => {
  const dir = mkdtempSync(join(tmpdir(), 'greview-help-routing-test-'));
  scratch.push(dir);

  const direct = runRaw(dir, 'onsubmit', 'add', '--help');
  const routed = runRaw(dir, 'help', 'onsubmit', 'add');
  assert.equal(routed.status, 0, routed.stderr);
  assert.equal(routed.stdout, direct.stdout);

  const unknown = runRaw(dir, 'help', 'does-not-exist');
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /no help topic/);
});

test(
  'setup skill delegates to the interactive skills CLI without requiring a git repository',
  { skip: process.platform === 'win32' },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'greview-skill-test-'));
    scratch.push(dir);
    const argsPath = join(dir, 'args.txt');
    const fakeNpx = join(dir, 'npx');
    writeFileSync(fakeNpx, '#!/bin/sh\nprintf "%s\\n" "$@" > "$GREVIEW_TEST_ARGS"\n');
    chmodSync(fakeNpx, 0o755);

    const result = runRawEnv(
      dir,
      {
        GREVIEW_TEST_ARGS: argsPath,
        PATH: `${dir}:${process.env.PATH ?? ''}`,
      },
      'setup',
      'skill',
    );

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(argsPath, 'utf8').trimEnd().split('\n'), [
      '--yes',
      'skills',
      'add',
      'YouXam/greview',
      '--skill',
      'greview',
    ]);
  },
);

test(
  'setup extension delegates to the VS Code CLI without requiring a git repository',
  { skip: process.platform === 'win32' },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'greview-extension-test-'));
    scratch.push(dir);
    const argsPath = join(dir, 'args.txt');
    const fakeCode = join(dir, 'code');
    writeFileSync(fakeCode, '#!/bin/sh\nprintf "%s\\n" "$@" > "$GREVIEW_TEST_ARGS"\n');
    chmodSync(fakeCode, 0o755);

    const result = runRawEnv(
      dir,
      { GREVIEW_TEST_ARGS: argsPath, PATH: `${dir}:${process.env.PATH ?? ''}` },
      'setup',
      'extension',
    );

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(argsPath, 'utf8').trimEnd().split('\n'), [
      '--install-extension',
      'youxam.greview',
    ]);
  },
);

test(
  'setup extension explains how to install when the VS Code CLI is unavailable',
  { skip: process.platform === 'win32' },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'greview-no-code-test-'));
    scratch.push(dir);

    const result = runRawEnv(dir, { PATH: dir }, 'setup', 'extension');

    assert.equal(result.status, 1);
    assert.match(result.stderr, /could not start code/);
    assert.match(result.stderr, /marketplace\.visualstudio\.com\/items\?itemName=youxam\.greview/);
  },
);

test(
  'setup interactively installs both selected components',
  { skip: process.platform === 'win32' },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'greview-setup-test-'));
    scratch.push(dir);
    const npxArgs = join(dir, 'npx-args.txt');
    const codeArgs = join(dir, 'code-args.txt');
    writeFileSync(join(dir, 'npx'), `#!/bin/sh\nprintf "%s\\n" "$@" > "${npxArgs}"\n`);
    writeFileSync(join(dir, 'code'), `#!/bin/sh\nprintf "%s\\n" "$@" > "${codeArgs}"\n`);
    chmodSync(join(dir, 'npx'), 0o755);
    chmodSync(join(dir, 'code'), 0o755);

    const result = runRawInputEnv(dir, '3\n', { PATH: `${dir}:${process.env.PATH ?? ''}` }, 'setup');

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1\) Agent skill/);
    assert.equal(
      readFileSync(npxArgs, 'utf8').trimEnd(),
      ['--yes', 'skills', 'add', 'YouXam/greview', '--skill', 'greview'].join('\n'),
    );
    assert.equal(
      readFileSync(codeArgs, 'utf8').trimEnd(),
      ['--install-extension', 'youxam.greview'].join('\n'),
    );
  },
);

test('the database lives in this worktree own git dir', () => {
  const dir = makeRepo(base);
  const info = run<RepoInfo>(dir, 'repo');
  assert.ok(info.dbPath.endsWith('/review/comments.sqlite'), info.dbPath);
  assert.ok(info.dbPath.startsWith(info.gitDir), `${info.dbPath} not under ${info.gitDir}`);
  assert.equal(info.branch, 'main');
});

test('a linked worktree gets its own database', () => {
  const dir = makeRepo(base);
  const linked = join(dir, '..', `wt-${Date.now().toString(36)}`);
  git(dir, 'worktree', 'add', '-q', '-b', 'side', linked);
  scratch.push(linked);
  const main = run<RepoInfo>(dir, 'repo');
  const side = run<RepoInfo>(linked, 'repo');
  assert.notEqual(main.dbPath, side.dbPath);
  assert.ok(side.gitDir.includes('worktrees'), side.gitDir);
  git(dir, 'worktree', 'remove', '--force', linked);
});

test('an unstaged edit can be commented on and stays current', () => {
  const dir = makeRepo(base);
  writeFileSync(join(dir, 'a.txt'), `${['one', 'two', 'THREE', 'four', 'five', 'six', 'seven', 'eight'].join('\n')}\n`);

  const created = run<Thread>(dir, 'add', '--file', 'a.txt', '--line', '3', '-m', 'why uppercase?');
  assert.equal(created.id, 1);
  assert.equal(created.target, 'worktree');
  assert.equal(created.side, 'new');
  assert.equal(created.current.drift, 'current');
  assert.deepEqual(created.anchor.lines, ['THREE']);
  assert.ok(created.anchor.hunkHeader?.startsWith('@@ '), created.anchor.hunkHeader ?? 'no hunk');
  assert.equal(created.ref, 'a.txt:3');
  assert.equal(created.comments.length, 1);
  assert.equal(created.comments[0]?.body, 'why uppercase?');
  assert.equal(created.comments[0]?.authorKind, 'human');

  const open = run<Thread[]>(dir, 'list');
  assert.equal(open.length, 1);
  assert.equal(open[0]?.current.drift, 'current');
});

test('inserting lines above the comment moves it and keeps it anchored', () => {
  const dir = makeRepo(base);
  writeFileSync(join(dir, 'a.txt'), `${['one', 'two', 'THREE', 'four'].join('\n')}\n`);
  run<Thread>(dir, 'add', '--file', 'a.txt', '--line', '3', '-m', 'look here');

  writeFileSync(join(dir, 'a.txt'), `${['zero', 'half', 'one', 'two', 'THREE', 'four'].join('\n')}\n`);
  const t = run<Thread>(dir, 'show', '1');
  assert.equal(t.current.drift, 'moved');
  assert.deepEqual(t.current.region?.lines, ['THREE']);
  assert.equal(t.current.region?.start, 5);
  assert.equal(t.ref, 'a.txt:5');
  // Deleting or adding a line above a comment shifts it, and saying so on every
  // affected thread is noise: the content is identical and `ref` is already right.
  assert.deepEqual(t.current.notes, [], JSON.stringify(t.current.notes));
});

test('one deleted line above many comments says nothing about any of them', () => {
  const dir = makeRepo(base);
  const edited = ['one', 'two', 'THREE', 'four', 'FIVE', 'six', 'SEVEN', 'eight'];
  writeFileSync(join(dir, 'a.txt'), `${edited.join('\n')}\n`);
  for (const line of [3, 5, 7]) {
    run<Thread>(dir, 'add', '--file', 'a.txt', '--line', String(line), '-m', `about ${line}`);
  }

  // Drop the first line: every thread below shifts up by one.
  writeFileSync(join(dir, 'a.txt'), `${edited.slice(1).join('\n')}\n`);
  const threads = run<Thread[]>(dir, 'list');
  assert.equal(threads.length, 3);
  for (const t of threads) {
    assert.equal(t.current.drift, 'moved', `#${t.id} should have followed its lines`);
    assert.deepEqual(t.current.notes, [], `#${t.id} should report nothing`);
    assert.equal(t.current.region?.start, t.anchor.start - 1);
    assert.deepEqual(t.current.region?.lines, t.anchor.lines, 'content is untouched');
  }
});

test('editing the commented lines reports changed with before and after', () => {
  const dir = makeRepo(base);
  writeFileSync(join(dir, 'a.txt'), `${['one', 'two', 'THREE', 'four'].join('\n')}\n`);
  run<Thread>(dir, 'add', '--file', 'a.txt', '--line', '3', '-m', 'look here');

  writeFileSync(join(dir, 'a.txt'), `${['one', 'two', 'three (fixed)', 'four'].join('\n')}\n`);
  const t = run<Thread>(dir, 'show', '1');
  assert.equal(t.current.drift, 'changed');
  assert.deepEqual(t.anchor.lines, ['THREE'], 'the original snapshot must survive the edit');
  assert.deepEqual(t.current.region?.lines, ['three (fixed)']);
  assert.equal(t.status, 'open', 'a rewrite must never auto-resolve a thread');

  const drift = t.events.find((e) => e.kind === 'drift');
  assert.ok(drift, `expected a drift event, got ${t.events.map((e) => e.kind).join(',')}`);
  assert.deepEqual(drift?.detail.before, ['THREE']);
  assert.deepEqual(drift?.detail.after, ['three (fixed)']);
});

test('deleting the commented lines is reported, not hidden', () => {
  const dir = makeRepo(base);
  writeFileSync(join(dir, 'a.txt'), `${['one', 'DOOMED', 'three'].join('\n')}\n`);
  run<Thread>(dir, 'add', '--file', 'a.txt', '--line', '2', '-m', 'drop this?');

  writeFileSync(join(dir, 'a.txt'), `${['one', 'three'].join('\n')}\n`);
  const t = run<Thread>(dir, 'show', '1');
  assert.equal(t.current.drift, 'changed');
  assert.deepEqual(t.current.region?.lines, []);
  assert.ok(t.current.notes.some((n) => n.code === 'deleted'), JSON.stringify(t.current.notes));
});

test('staging then committing the commented content is tracked', () => {
  const dir = makeRepo(base);
  writeFileSync(join(dir, 'a.txt'), `${['one', 'two', 'THREE', 'four'].join('\n')}\n`);
  run<Thread>(dir, 'add', '--file', 'a.txt', '--line', '3', '-m', 'review this');

  let t = run<Thread>(dir, 'show', '1');
  assert.equal(t.current.locations.worktree, 'current');
  assert.notEqual(t.current.locations.index, 'current');

  git(dir, 'add', 'a.txt');
  t = run<Thread>(dir, 'show', '1');
  assert.equal(t.current.locations.index, 'current');
  assert.ok(t.current.notes.some((n) => n.code === 'staged'), JSON.stringify(t.current.notes));
  assert.ok(t.events.some((e) => e.kind === 'staged'), t.events.map((e) => e.kind).join(','));
  assert.equal(t.status, 'open', 'staging is a signal, not a resolution');

  git(dir, 'commit', '-q', '-m', 'apply');
  t = run<Thread>(dir, 'show', '1');
  assert.equal(t.current.locations.head, 'current');
  assert.ok(
    t.current.notes.some((n) => n.code === 'committed'),
    JSON.stringify(t.current.notes),
  );
  assert.ok(t.events.some((e) => e.kind === 'committed'), t.events.map((e) => e.kind).join(','));
});

test('a comment on the staged diff anchors to the index, not the working tree', () => {
  const dir = makeRepo(base);
  writeFileSync(join(dir, 'a.txt'), `${['one', 'STAGED', 'three'].join('\n')}\n`);
  git(dir, 'add', 'a.txt');
  // A later unstaged edit must not disturb a thread anchored to the index.
  writeFileSync(join(dir, 'a.txt'), `${['one', 'STAGED', 'three', 'unstaged tail'].join('\n')}\n`);

  const t = run<Thread>(dir, 'add', '--file', 'a.txt', '--line', '2', '--target', 'index', '-m', 'staged review');
  assert.equal(t.target, 'index');
  assert.equal(t.current.drift, 'current');

  writeFileSync(join(dir, 'a.txt'), `${['one', 'REWRITTEN', 'three'].join('\n')}\n`);
  const after = run<Thread>(dir, 'show', '1');
  assert.equal(after.current.drift, 'current', 'the index copy is untouched');
  assert.equal(after.current.locations.worktree, 'changed');
  assert.ok(
    after.current.notes.some((n) => n.code === 'worktree-diverged'),
    JSON.stringify(after.current.notes),
  );
});

test('the old side of a diff can be commented on', () => {
  const dir = makeRepo(base);
  writeFileSync(join(dir, 'a.txt'), `${['one', 'CHANGED', 'three', 'four', 'five', 'six', 'seven', 'eight'].join('\n')}\n`);
  const t = run<Thread>(dir, 'add', '--file', 'a.txt', '--line', '2', '--side', 'old', '-m', 'why remove this?');
  assert.equal(t.side, 'old');
  assert.deepEqual(t.anchor.lines, ['two'], 'the old side reads from the index');
  assert.equal(t.current.drift, 'current');
});

test('a deleted file leaves the thread orphaned rather than silently dropped', () => {
  const dir = makeRepo(base);
  writeFileSync(join(dir, 'a.txt'), `${['one', 'TWO', 'three'].join('\n')}\n`);
  run<Thread>(dir, 'add', '--file', 'a.txt', '--line', '2', '-m', 'hmm');
  rmSync(join(dir, 'a.txt'));

  const t = run<Thread>(dir, 'show', '1');
  assert.equal(t.current.drift, 'orphaned');
  assert.equal(t.current.region, null);
  assert.deepEqual(t.anchor.lines, ['TWO'], 'the snapshot outlives the file');
});

test('a renamed file is followed instead of going orphaned', () => {
  const dir = makeRepo(['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']);
  run<Thread>(dir, 'add', '--file', 'a.txt', '--line', '2', '--target', 'head', '-m', 'about beta');
  git(dir, 'mv', 'a.txt', 'b.txt');

  const t = run<Thread>(dir, 'show', '1');
  assert.equal(t.filePath, 'b.txt');
  assert.ok(
    t.current.notes.some((n) => n.code === 'renamed' && n.args?.path === 'b.txt'),
    JSON.stringify(t.current.notes),
  );
  assert.notEqual(t.current.drift, 'orphaned');
});

test('replies, resolve and reopen are recorded with authors', () => {
  const dir = makeRepo(base);
  writeFileSync(join(dir, 'a.txt'), `${['one', 'TWO', 'three'].join('\n')}\n`);
  run<Thread>(dir, 'add', '--file', 'a.txt', '--line', '2', '-m', 'please explain');

  run<Thread>(dir, 'reply', '1', '-m', 'fixed in abc1234', '--agent', '--author', 'claude');
  let t = run<Thread>(dir, 'show', '1');
  assert.equal(t.comments.length, 2);
  assert.equal(t.comments[1]?.author, 'claude');
  assert.equal(t.comments[1]?.authorKind, 'agent');

  t = run<Thread>(dir, 'resolve', '1', '--by', 'youxam');
  assert.equal(t.status, 'resolved');
  assert.equal(t.resolvedBy, 'youxam');
  assert.equal(run<Thread[]>(dir, 'list').length, 0, 'resolved threads are hidden by default');
  assert.equal(run<Thread[]>(dir, 'list', '--all').length, 1);
  assert.equal(run<Thread[]>(dir, 'list', '--resolved').length, 1);

  t = run<Thread>(dir, 'unresolve', '1');
  assert.equal(t.status, 'open');
  assert.ok(t.events.some((e) => e.kind === 'unresolved'));
});

test('a comment on pre-existing code is not announced as newly committed', () => {
  const dir = makeRepo(base);
  // 'three' is untouched code that already exists in HEAD and the index; a
  // comment on it must not claim the content got staged or committed later.
  writeFileSync(join(dir, 'a.txt'), `${['one', 'two', 'three', 'FOUR', 'five', 'six', 'seven', 'eight'].join('\n')}\n`);
  run<Thread>(dir, 'add', '--file', 'a.txt', '--line', '3', '-m', 'this line is load-bearing');

  git(dir, 'add', 'a.txt');
  git(dir, 'commit', '-q', '-m', 'unrelated change');

  const t = run<Thread>(dir, 'show', '1');
  assert.equal(t.current.drift, 'current');
  assert.deepEqual(t.current.notes, [], `expected no transition notes, got ${JSON.stringify(t.current.notes)}`);
  assert.equal(t.current.locations.head, 'current', 'the line is in HEAD, it just always was');
});

test('staging a rewrite of the commented lines is called out', () => {
  const dir = makeRepo(base);
  writeFileSync(join(dir, 'a.txt'), `${['one', 'TWO', 'three'].join('\n')}\n`);
  run<Thread>(dir, 'add', '--file', 'a.txt', '--line', '2', '-m', 'this is wrong');

  writeFileSync(join(dir, 'a.txt'), `${['one', 'two (fixed)', 'three'].join('\n')}\n`);
  git(dir, 'add', 'a.txt');

  const t = run<Thread>(dir, 'show', '1');
  assert.equal(t.current.drift, 'changed');
  assert.ok(
    t.current.notes.some((n) => n.code === 'replacement-staged'),
    JSON.stringify(t.current.notes),
  );
  assert.equal(t.status, 'open');
});

test('a settled list writes nothing to the database', () => {
  const dir = makeRepo(base);
  writeFileSync(join(dir, 'a.txt'), `${['one', 'TWO', 'three'].join('\n')}\n`);
  run<Thread>(dir, 'add', '--file', 'a.txt', '--line', '2', '-m', 'steady state');
  run<Thread[]>(dir, 'list');

  // The extension watches this directory and refreshes when it changes. If a
  // read-only sync stamped the row anyway, that watch would fire, trigger another
  // list, and the UI would refresh forever.
  const reviewDir = join(dir, '.git', 'review');
  const fingerprint = (): string =>
    readdirSync(reviewDir)
      .sort()
      .map((name) => {
        const s = statSync(join(reviewDir, name));
        return `${name}:${s.size}:${s.mtimeMs}`;
      })
      .join('|');

  const before = fingerprint();
  for (let i = 0; i < 3; i++) run<Thread[]>(dir, 'list');
  assert.equal(fingerprint(), before, 'repeated reads must leave the database untouched');

  // A real change must still be picked up.
  writeFileSync(join(dir, 'a.txt'), `${['one', 'two edited', 'three'].join('\n')}\n`);
  run<Thread[]>(dir, 'list');
  assert.notEqual(fingerprint(), before, 'an actual edit must be recorded');
});

test('a comment can be rewritten, and says that it was', () => {
  const dir = makeRepo(base);
  writeFileSync(join(dir, 'a.txt'), `${['one', 'TWO', 'three'].join('\n')}\n`);
  const created = run<Thread>(dir, 'add', '--file', 'a.txt', '--line', '2', '-m', 'tpyo here');
  const commentId = created.comments[0]!.id;
  assert.equal(created.comments[0]?.editedAt, null);

  const edited = run<Thread>(dir, 'edit', String(commentId), '-m', 'typo here — should be "two"');
  assert.equal(edited.comments.length, 1, 'editing must not append a second comment');
  assert.equal(edited.comments[0]?.body, 'typo here — should be "two"');
  assert.ok(edited.comments[0]?.editedAt, 'an edited comment records when');

  // The anchor is untouched by an edit to the prose.
  assert.deepEqual(edited.anchor.lines, ['TWO']);
  assert.equal(runRaw(dir, 'edit', '999', '-m', 'nope').status, 2);
});

test('the plain-text listing distinguishes the two sides of a diff', () => {
  const dir = makeRepo(base);
  writeFileSync(join(dir, 'a.txt'), `${['one', 'CHANGED', 'three'].join('\n')}\n`);
  run<Thread>(dir, 'add', '--file', 'a.txt', '--line', '2', '--side', 'new', '-m', 'about the new line');
  run<Thread>(dir, 'add', '--file', 'a.txt', '--line', '2', '--side', 'old', '-m', 'about the old line');

  // Two threads on the same file and line differing only by side must not print
  // identically, or the listing is useless for telling them apart.
  const text = runText(dir, 'list');
  assert.match(text, /new side/, text);
  assert.match(text, /old side/, text);

  const lines = text.split('\n').filter((l) => l.includes('a.txt:'));
  assert.equal(lines.length, 2, text);
  assert.notEqual(lines[0], lines[1], 'the two entries must be distinguishable');
});

test('stats counts what needs attention', () => {
  const dir = makeRepo(base);
  writeFileSync(join(dir, 'a.txt'), `${['one', 'TWO', 'three', 'FOUR'].join('\n')}\n`);
  run<Thread>(dir, 'add', '--file', 'a.txt', '--line', '2', '-m', 'a');
  run<Thread>(dir, 'add', '--file', 'a.txt', '--line', '4', '-m', 'b');
  run<Thread>(dir, 'resolve', '2');
  writeFileSync(join(dir, 'a.txt'), `${['one', 'two edited', 'three', 'FOUR'].join('\n')}\n`);

  const s = run<Stats>(dir, 'stats');
  assert.deepEqual(s, { open: 1, resolved: 1, changed: 1, orphaned: 0 });
});

test('list is filterable by file and target', () => {
  const dir = makeRepo(base);
  writeFileSync(join(dir, 'a.txt'), `${['one', 'TWO', 'three'].join('\n')}\n`);
  writeFileSync(join(dir, 'b.txt'), 'other\nlines\n');
  git(dir, 'add', 'b.txt');
  run<Thread>(dir, 'add', '--file', 'a.txt', '--line', '2', '-m', 'on a');
  run<Thread>(dir, 'add', '--file', 'b.txt', '--line', '1', '--target', 'index', '-m', 'on b');

  assert.equal(run<Thread[]>(dir, 'list', '--file', 'a.txt').length, 1);
  assert.equal(run<Thread[]>(dir, 'list', '--target', 'index').length, 1);
  assert.equal(run<Thread[]>(dir, 'list', '--target', 'worktree')[0]?.filePath, 'a.txt');
});

test('bad input is refused with a usage exit code and no thread', () => {
  const dir = makeRepo(base);
  const missingFile = runRaw(dir, 'add', '--line', '1', '-m', 'x');
  assert.equal(missingFile.status, 2);
  assert.match(missingFile.stdout, /--file/);

  const pastEnd = runRaw(dir, 'add', '--file', 'a.txt', '--line', '999', '-m', 'x');
  assert.equal(pastEnd.status, 2);
  assert.match(pastEnd.stdout, /past the end/);

  const inverted = runRaw(dir, 'add', '--file', 'a.txt', '--line', '9-2', '-m', 'x');
  assert.equal(inverted.status, 2);

  const noSuchThread = runRaw(dir, 'show', '42');
  assert.equal(noSuchThread.status, 2);

  assert.equal(run<Thread[]>(dir, 'list', '--all').length, 0);
});

test('rm forgets a thread and its comments', () => {
  const dir = makeRepo(base);
  writeFileSync(join(dir, 'a.txt'), `${['one', 'TWO', 'three'].join('\n')}\n`);
  run<Thread>(dir, 'add', '--file', 'a.txt', '--line', '2', '-m', 'temporary');
  run<{ deleted: boolean }>(dir, 'rm', '1');
  assert.equal(run<Thread[]>(dir, 'list', '--all').length, 0);
  assert.equal(runRaw(dir, 'show', '1').status, 2);
});

test('submit hooks are per-worktree and survive a round trip', () => {
  const dir = makeRepo(base);
  assert.deepEqual(run<Callback[]>(dir, 'onsubmit', 'list'), []);

  run<Callback[]>(dir, 'onsubmit', 'add', 'notify', 'echo hello');
  const list = run<Callback[]>(dir, 'onsubmit', 'add', 'second', 'true');
  assert.deepEqual(
    list.map((c) => [c.name, c.command]),
    [['notify', 'echo hello'], ['second', 'true']],
  );

  // Adding the same name replaces rather than duplicating, so an agent can
  // re-register on every run without piling up hooks.
  const replaced = run<Callback[]>(dir, 'onsubmit', 'add', 'notify', 'echo goodbye');
  assert.equal(replaced.length, 2);
  assert.equal(replaced.find((c) => c.name === 'notify')?.command, 'echo goodbye');

  assert.equal(run<Callback[]>(dir, 'onsubmit', 'delete', 'second').length, 1);
  assert.equal(runRaw(dir, 'onsubmit', 'delete', 'nope').status, 2);

  const linked = join(dir, '..', `wt-hooks-${process.pid.toString(36)}`);
  git(dir, 'worktree', 'add', '-q', '-b', 'hooks-side', linked);
  scratch.push(linked);
  assert.deepEqual(run<Callback[]>(linked, 'onsubmit', 'list'), [], 'hooks do not leak across worktrees');
  git(dir, 'worktree', 'remove', '--force', linked);

  assert.equal(run<{ removed: number }>(dir, 'onsubmit', 'clear').removed, 1);
  assert.deepEqual(run<Callback[]>(dir, 'onsubmit', 'list'), []);
});

test('running hooks executes every one through the shell and reports each', () => {
  const dir = makeRepo(base);
  run<Callback[]>(dir, 'onsubmit', 'add', 'good', 'echo submitted');
  run<Callback[]>(dir, 'onsubmit', 'add', 'bad', 'exit 3');
  run<Callback[]>(dir, 'onsubmit', 'add', 'cwd', 'pwd');

  const results = run<CallbackResult[]>(dir, 'onsubmit', 'run');
  assert.equal(results.length, 3);
  const byName = new Map(results.map((r) => [r.name, r]));

  assert.equal(byName.get('good')?.code, 0);
  assert.equal(byName.get('good')?.stdout, 'submitted');
  assert.equal(byName.get('bad')?.code, 3, 'a failing hook reports its exit code');
  // Shell features must work, and hooks run at the repository root.
  assert.equal(byName.get('cwd')?.stdout, realpathSync(dir));
});

test('a failing hook makes run exit non-zero without hiding the others', () => {
  const dir = makeRepo(base);
  run<Callback[]>(dir, 'onsubmit', 'add', 'ok', 'true');
  run<Callback[]>(dir, 'onsubmit', 'add', 'boom', 'exit 1');
  const r = runRaw(dir, 'onsubmit', 'run');
  assert.equal(r.status, 1);
  const parsed = JSON.parse(r.stdout) as { ok: boolean; data: CallbackResult[] };
  assert.equal(parsed.ok, true, 'results are still reported');
  assert.equal(parsed.data.length, 2);
});

test('running with no hooks configured is not an error', () => {
  const dir = makeRepo(base);
  assert.deepEqual(run<CallbackResult[]>(dir, 'onsubmit', 'run'), []);
});

test('a hook name and command are both required', () => {
  const dir = makeRepo(base);
  assert.equal(runRaw(dir, 'onsubmit', 'add').status, 2);
  assert.equal(runRaw(dir, 'onsubmit', 'add', 'onlyname').status, 2);
  assert.equal(runRaw(dir, 'onsubmit', 'bogus').status, 2);
});

test('an agent comment is never attributed to the human reviewer', () => {
  const dir = makeRepo(base);
  writeFileSync(join(dir, 'a.txt'), `${['one', 'TWO', 'three'].join('\n')}\n`);

  // git config user.name is the reviewer's identity. An agent wearing it would be
  // indistinguishable from a comment the reviewer wrote.
  const paseo = runEnv<Thread>(
    dir,
    { AI_AGENT: 'claude-code_2-1-220_agent' },
    'add', '--file', 'a.txt', '--line', '2', '-m', 'noticed this',
  );
  assert.equal(paseo.comments[0]?.author, 'claude-code');
  assert.equal(paseo.comments[0]?.authorKind, 'agent', 'the marker implies --agent');

  const claude = runEnv<Thread>(dir, { CLAUDECODE: '1' }, 'reply', '1', '-m', 'and this');
  assert.equal(claude.comments[1]?.author, 'claude-code');
  assert.equal(claude.comments[1]?.authorKind, 'agent');

  // An explicit name always wins over detection.
  const named = runEnv<Thread>(dir, { AI_AGENT: 'codex_1_agent' }, 'reply', '1', '-m', 'x', '--author', 'reviewer-bot');
  assert.equal(named.comments[2]?.author, 'reviewer-bot');
  assert.equal(named.comments[2]?.authorKind, 'agent');
});

test('an unidentifiable agent is told to name itself rather than borrowing a name', () => {
  const dir = makeRepo(base);
  writeFileSync(join(dir, 'a.txt'), `${['one', 'TWO', 'three'].join('\n')}\n`);
  const r = runRawEnv(dir, {}, 'add', '--file', 'a.txt', '--line', '2', '-m', 'hi', '--agent');
  assert.equal(r.status, 2);
  assert.match(r.stdout, /must name itself/);
  assert.match(r.stdout, /user\.name/, 'the error explains why the git name is refused');
});

test('a person working in an agent shell can say so', () => {
  const dir = makeRepo(base);
  writeFileSync(join(dir, 'a.txt'), `${['one', 'TWO', 'three'].join('\n')}\n`);
  const t = runEnv<Thread>(
    dir,
    { AI_AGENT: 'claude-code_2-1-220_agent', GREVIEW_AUTHOR_KIND: 'human' },
    'add', '--file', 'a.txt', '--line', '2', '-m', 'mine',
  );
  assert.equal(t.comments[0]?.authorKind, 'human');
  assert.equal(t.comments[0]?.author, 'Test', 'falls back to git config user.name');
});

/** Bytes 18-19 of a SQLite header are the write/read file-format versions: 1 for a rollback journal, 2 for WAL. */
function journalFormat(dbPath: string): number {
  return readFileSync(dbPath)[18]!;
}

test('the database keeps a rollback journal, which network filesystems can lock', () => {
  const dir = makeRepo(base);
  run<Thread>(dir, 'add', '--file', 'a.txt', '--line', '2', '-m', 'note', '--author', 'x');
  const info = run<RepoInfo>(dir, 'repo');
  assert.equal(journalFormat(info.dbPath), 1, 'not in WAL mode');
  assert.ok(!existsSync(`${info.dbPath}-wal`), 'no WAL sidecar');
});

test('a database an older greview left in WAL mode converts back', () => {
  const dir = makeRepo(base);
  run<Thread>(dir, 'add', '--file', 'a.txt', '--line', '2', '-m', 'note', '--author', 'x');
  const info = run<RepoInfo>(dir, 'repo');
  const flip = spawnSync(
    process.execPath,
    [
      '-e',
      `const { DatabaseSync } = require('node:sqlite');
       const db = new DatabaseSync(process.argv[1]);
       db.exec('PRAGMA journal_mode = WAL');
       db.close();`,
      info.dbPath,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(flip.status, 0, flip.stderr);
  assert.equal(journalFormat(info.dbPath), 2, 'the old CLI left WAL behind');

  run<Thread[]>(dir, 'list');
  assert.equal(journalFormat(info.dbPath), 1, 'one command later it is a rollback journal again');
  assert.ok(!existsSync(`${info.dbPath}-wal`), 'the WAL sidecar is cleaned up');
});

test('concurrent commands on one database all succeed', async () => {
  const dir = makeRepo(base);
  run<Thread>(dir, 'add', '--file', 'a.txt', '--line', '2', '-m', 'note', '--author', 'x');
  const sync = () =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn(
        process.execPath,
        ['--experimental-strip-types', '--no-warnings', CLI, 'sync', '--json', '--cwd', dir],
        { cwd: dir, env: cleanEnv() },
      );
      let out = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr.on('data', (d: Buffer) => (out += d.toString()));
      child.on('close', (code) => resolve({ code, out }));
    });
  for (let round = 0; round < 6; round++) {
    const results = await Promise.all([sync(), sync(), sync()]);
    for (const r of results) assert.equal(r.code, 0, `round ${round}: ${r.out}`);
  }
});
