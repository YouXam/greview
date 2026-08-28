import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { DiffTarget, Side, Version } from './protocol.ts';

export class GitError extends Error {}

function git(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new GitError(`failed to run git: ${r.error.message}`);
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function gitOk(cwd: string, args: string[]): string {
  const r = git(cwd, args);
  if (r.status !== 0) throw new GitError(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

export interface Repo {
  /** Working tree root, absolute, no trailing slash. */
  root: string;
  /** `.git` in the primary checkout, `.git/worktrees/<name>` in a linked one. */
  gitDir: string;
}

export function findRepo(cwd: string): Repo {
  const root = gitOk(cwd, ['rev-parse', '--show-toplevel']).trim();
  const gitDir = gitOk(cwd, ['rev-parse', '--absolute-git-dir']).trim();
  if (!root) throw new GitError('not inside a git working tree');
  return { root, gitDir };
}

export function headSha(repo: Repo): string | null {
  const r = git(repo.root, ['rev-parse', 'HEAD']);
  return r.status === 0 ? r.stdout.trim() : null;
}

export function branchName(repo: Repo): string | null {
  const r = git(repo.root, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const name = r.stdout.trim();
  return r.status === 0 && name ? name : null;
}

/** Normalises a user-supplied path to repo-relative with forward slashes. */
export function toRepoPath(repo: Repo, input: string, cwd = process.cwd()): string {
  const r = git(cwd, ['ls-files', '--full-name', '-co', '--error-unmatch', '--', input]);
  if (r.status === 0) {
    const first = r.stdout.split('\n').find((l) => l.trim() !== '');
    if (first) return first.trim();
  }
  // ls-files omits ignored files; fall back to a lexical relative path.
  const abs = isAbsolute(input) ? input : resolve(cwd, input);
  const rel = relative(repo.root, abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new GitError(`${input} is outside ${repo.root}`);
  }
  return rel.split('\\').join('/');
}

/** Reads a file version, or null when it does not exist there. */
export function readVersion(repo: Repo, version: Version, path: string): string | null {
  if (version === 'worktree') {
    try {
      return readFileSync(join(repo.root, path), 'utf8');
    } catch {
      return null;
    }
  }
  const spec = version === 'index' ? `:${path}` : `HEAD:${path}`;
  const r = git(repo.root, ['cat-file', 'blob', spec]);
  return r.status === 0 ? r.stdout : null;
}

/** Which file version a (target, side) pair reads from. */
export function versionFor(target: DiffTarget, side: Side): Version {
  if (side === 'new') return target === 'index' ? 'index' : 'worktree';
  return target === 'worktree' ? 'index' : 'head';
}

const DIFF_ARGS: Record<DiffTarget, string[]> = {
  worktree: [],
  index: ['--cached'],
  head: ['HEAD'],
};

export interface Hunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

export function hunks(repo: Repo, target: DiffTarget, path: string): Hunk[] {
  const r = git(repo.root, [
    '--no-pager',
    'diff',
    ...DIFF_ARGS[target],
    '--no-color',
    '-U0',
    '--',
    path,
  ]);
  if (r.status !== 0) return [];
  const out: Hunk[] = [];
  for (const line of r.stdout.split('\n')) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    out.push({
      header: line,
      oldStart: Number(m[1]),
      oldCount: m[2] === undefined ? 1 : Number(m[2]),
      newStart: Number(m[3]),
      newCount: m[4] === undefined ? 1 : Number(m[4]),
    });
  }
  return out;
}

/** The hunk header covering a line, or null when the line is unchanged code. */
export function hunkHeaderAt(
  repo: Repo,
  target: DiffTarget,
  side: Side,
  path: string,
  line: number,
): string | null {
  for (const h of hunks(repo, target, path)) {
    const start = side === 'new' ? h.newStart : h.oldStart;
    const count = side === 'new' ? h.newCount : h.oldCount;
    // A zero count is an insertion point, not a range.
    if (count === 0 ? line === start || line === start + 1 : line >= start && line < start + count) {
      return h.header;
    }
  }
  return null;
}

/** Paths that differ in a given diff, repo-relative. */
export function changedPaths(repo: Repo, target: DiffTarget): string[] {
  const r = git(repo.root, ['--no-pager', 'diff', ...DIFF_ARGS[target], '--name-only']);
  if (r.status !== 0) return [];
  return r.stdout.split('\n').filter((l) => l.trim() !== '');
}

/** The new name of `path` if the pending changes rename it. */
export function renameOf(repo: Repo, path: string): string | null {
  const r = git(repo.root, [
    '--no-pager',
    'diff',
    'HEAD',
    '--name-status',
    '--find-renames',
    '--diff-filter=R',
  ]);
  if (r.status !== 0) return null;
  for (const line of r.stdout.split('\n')) {
    const parts = line.split('\t');
    if (parts.length >= 3 && parts[0]!.startsWith('R') && parts[1] === path) return parts[2]!;
  }
  return null;
}
