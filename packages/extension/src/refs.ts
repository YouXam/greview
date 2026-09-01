import { realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { DiffTarget, Side } from '@greview/protocol';

/** The parts of a `vscode.Uri` this module needs. */
export interface UriLike {
  scheme: string;
  query: string;
  fsPath: string;
}

/** Refs the built-in git extension uses for the index; it writes `~`. */
const INDEX_REFS = new Set(['~', '', ':']);

/** Stands in for "the file on disk", which has no ref of its own. */
export const WORKTREE = '\0worktree';

/** The git ref a document represents, or null when it is not a git document. */
export function refOf(uri: UriLike): string | null {
  if (uri.scheme === 'file') return WORKTREE;
  if (uri.scheme !== 'git') return null;
  try {
    const parsed = JSON.parse(uri.query) as { ref?: unknown };
    return typeof parsed.ref === 'string' ? parsed.ref : null;
  } catch {
    return null;
  }
}

/** The filesystem path a document stands for, across `file:` and `git:` URIs. */
export function fsPathOf(uri: UriLike): string | null {
  if (uri.scheme === 'file') return uri.fsPath;
  if (uri.scheme !== 'git') return null;
  try {
    const parsed = JSON.parse(uri.query) as { path?: unknown };
    return typeof parsed.path === 'string' && parsed.path !== '' ? parsed.path : null;
  } catch {
    return null;
  }
}

/**
 * Which of the three diffs a pair of sides describes; null for anything else.
 *
 * `~` is both the right side of the staged diff and the left side of the unstaged
 * one, so a single URI is never enough to decide.
 */
export function pairTarget(originalRef: string, modifiedRef: string): DiffTarget | null {
  const left = INDEX_REFS.has(originalRef) ? 'index' : originalRef === 'HEAD' ? 'head' : null;
  const right = modifiedRef === WORKTREE ? 'worktree' : INDEX_REFS.has(modifiedRef) ? 'index' : null;
  if (left === 'index' && right === 'worktree') return 'worktree';
  if (left === 'head' && right === 'index') return 'index';
  if (left === 'head' && right === 'worktree') return 'head';
  return null;
}

export interface DiffRole {
  side: Side;
  otherRef: string;
}

export interface Placement {
  side: Side;
  target: DiffTarget;
}

/** Which side of which diff a document is, given its role in an open diff editor. */
export function placementOf(ref: string, role: DiffRole | undefined): Placement | null {
  if (role) {
    const target =
      role.side === 'old' ? pairTarget(ref, role.otherRef) : pairTarget(role.otherRef, ref);
    return target === null ? null : { side: role.side, target };
  }
  if (ref === WORKTREE) {
    // A plain file with no diff around it counts as the whole pending change.
    return { side: 'new', target: 'head' };
  }
  if (INDEX_REFS.has(ref)) return { side: 'new', target: 'index' };
  return null;
}

/** Repo-relative path with forward slashes, or null when outside the root. */
export function relativeTo(root: string, fsPath: string): string | null {
  const normalisedRoot = root.endsWith('/') ? root.slice(0, -1) : root;
  if (fsPath === normalisedRoot) return null;
  if (!fsPath.startsWith(`${normalisedRoot}/`)) return null;
  const rel = fsPath.slice(normalisedRoot.length + 1);
  return rel === '' ? null : rel.split('\\').join('/');
}

/**
 * The path with every symlink resolved. The editor knows a file by whatever
 * path the workspace was opened under, while git reports the repository root
 * physically — the two only compare after both are physical. A component that
 * does not exist (a deleted file still names a diff) is kept as written, on
 * top of the deepest ancestor that does resolve.
 */
export function physicalPath(fsPath: string): string {
  let head = fsPath;
  let tail = '';
  for (;;) {
    try {
      const resolved = realpathSync(head);
      return tail === '' ? resolved : join(resolved, tail);
    } catch {
      const parent = dirname(head);
      if (parent === head) return fsPath;
      tail = tail === '' ? basename(head) : join(basename(head), tail);
      head = parent;
    }
  }
}
