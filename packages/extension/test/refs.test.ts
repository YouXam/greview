import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  WORKTREE,
  fsPathOf,
  pairTarget,
  physicalPath,
  placementOf,
  refOf,
  relativeTo,
} from '../src/refs.ts';

/** How the built-in git extension builds a URI: scheme swapped, query carries both. */
const gitUri = (path: string, ref: string) => ({
  scheme: 'git',
  query: JSON.stringify({ path, ref }),
  fsPath: path,
});

const fileUri = (path: string) => ({ scheme: 'file', query: '', fsPath: path });

test('a file URI stands for the working tree', () => {
  assert.equal(refOf(fileUri('/repo/a.ts')), WORKTREE);
  assert.equal(fsPathOf(fileUri('/repo/a.ts')), '/repo/a.ts');
});

test('a git URI carries its ref and the real path', () => {
  assert.equal(refOf(gitUri('/repo/a.ts', '~')), '~');
  assert.equal(refOf(gitUri('/repo/a.ts', 'HEAD')), 'HEAD');
  assert.equal(fsPathOf(gitUri('/repo/a.ts', 'HEAD')), '/repo/a.ts');
});

test('unknown schemes and malformed queries are refused, not guessed', () => {
  assert.equal(refOf({ scheme: 'untitled', query: '', fsPath: '/x' }), null);
  assert.equal(refOf({ scheme: 'git', query: 'not json', fsPath: '/x' }), null);
  assert.equal(refOf({ scheme: 'git', query: '{}', fsPath: '/x' }), null);
  assert.equal(fsPathOf({ scheme: 'git', query: '{"ref":"~"}', fsPath: '/x' }), null);
});

test('the three diffs are told apart by their side pairing', () => {
  assert.equal(pairTarget('~', WORKTREE), 'worktree', 'index vs working tree');
  assert.equal(pairTarget('HEAD', '~'), 'index', 'HEAD vs index');
  assert.equal(pairTarget('HEAD', WORKTREE), 'head', 'HEAD vs working tree');
});

test('a diff against an arbitrary commit is not modelled', () => {
  assert.equal(pairTarget('abc1234', WORKTREE), null);
  assert.equal(pairTarget('HEAD~3', '~'), null);
  assert.equal(pairTarget(WORKTREE, WORKTREE), null);
});

test('the ambiguous index ref resolves from the role it plays', () => {
  // Right-hand side of the staged diff: the index is the new side.
  assert.deepEqual(placementOf('~', { side: 'new', otherRef: 'HEAD' }), {
    side: 'new',
    target: 'index',
  });
  // Left-hand side of the unstaged diff: the same ref is now the old side.
  assert.deepEqual(placementOf('~', { side: 'old', otherRef: WORKTREE }), {
    side: 'old',
    target: 'worktree',
  });
});

test('both sides of each diff place correctly', () => {
  assert.deepEqual(placementOf(WORKTREE, { side: 'new', otherRef: '~' }), {
    side: 'new',
    target: 'worktree',
  });
  assert.deepEqual(placementOf('HEAD', { side: 'old', otherRef: '~' }), {
    side: 'old',
    target: 'index',
  });
  assert.deepEqual(placementOf('HEAD', { side: 'old', otherRef: WORKTREE }), {
    side: 'old',
    target: 'head',
  });
  assert.deepEqual(placementOf(WORKTREE, { side: 'new', otherRef: 'HEAD' }), {
    side: 'new',
    target: 'head',
  });
});

test('a lone file is read as the whole pending change', () => {
  assert.deepEqual(placementOf(WORKTREE, undefined), { side: 'new', target: 'head' });
});

test('a lone index document is the staged new side', () => {
  assert.deepEqual(placementOf('~', undefined), { side: 'new', target: 'index' });
});

test('a lone historical document has no place to anchor', () => {
  assert.equal(placementOf('abc1234', undefined), null);
  assert.equal(placementOf('HEAD', undefined), null);
});

test('a document in an unmodelled diff is refused rather than mis-filed', () => {
  assert.equal(placementOf('abc1234', { side: 'new', otherRef: 'def5678' }), null);
});

test('paths are made repo-relative with forward slashes', () => {
  assert.equal(relativeTo('/repo', '/repo/src/a.ts'), 'src/a.ts');
  assert.equal(relativeTo('/repo/', '/repo/src/a.ts'), 'src/a.ts');
  assert.equal(relativeTo('/repo', '/repo'), null, 'the root itself is not a file');
  assert.equal(relativeTo('/repo', '/elsewhere/a.ts'), null);
  assert.equal(relativeTo('/repo', '/repo-sibling/a.ts'), null, 'prefix match must respect boundaries');
});

test('a document opened through a symlinked workspace still lands in the repo', (t) => {
  // A repository at a physical path, and the workspace opened via a symlink to it.
  const base = mkdtempSync(join(tmpdir(), 'greview-refs-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, 'physical', 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'a.ts'), '');
  symlinkSync(join(base, 'physical'), join(base, 'storage'));

  // tmpdir itself may sit behind symlinks (macOS /tmp), so the expected root is
  // whatever the physical repo path really is.
  const physicalRoot = realpathSync(repo);
  const viaLink = join(base, 'storage', 'repo', 'src', 'a.ts');

  assert.equal(physicalPath(viaLink), join(physicalRoot, 'src', 'a.ts'));
  assert.equal(relativeTo(physicalRoot, physicalPath(viaLink)), 'src/a.ts');
});

test('a deleted file behind a symlink still resolves onto its directory', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'greview-refs-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, 'physical', 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  symlinkSync(join(base, 'physical'), join(base, 'storage'));

  const physicalRoot = realpathSync(repo);
  const missingViaLink = join(base, 'storage', 'repo', 'src', 'deleted.ts');
  assert.equal(physicalPath(missingViaLink), join(physicalRoot, 'src', 'deleted.ts'));
});

test('a path that exists nowhere comes back unchanged', () => {
  assert.equal(physicalPath('/no/such/path/anywhere.ts'), '/no/such/path/anywhere.ts');
});

test('a fully physical path is untouched', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'greview-refs-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const file = join(realpathSync(base), 'a.ts');
  writeFileSync(file, '');
  assert.equal(physicalPath(file), file);
});
