/** The wire format shared by the CLI's `--json` output and the VS Code extension. */

/** Which side of a diff a thread is attached to. */
export type Side = 'new' | 'old';

/**
 * Which diff a thread was written against.
 * - `worktree`: index -> working tree (the unstaged diff)
 * - `index`: HEAD -> index (the staged diff)
 * - `head`: HEAD -> working tree (everything pending)
 */
export type DiffTarget = 'worktree' | 'index' | 'head';

/** The three file versions a target/side pair can resolve to. */
export type Version = 'worktree' | 'index' | 'head';

/**
 * - `current`: byte-identical content at the same line numbers
 * - `moved`: identical content, different line numbers
 * - `changed`: the lines themselves were edited
 * - `orphaned`: the file no longer exists in that version
 */
export type Drift = 'current' | 'moved' | 'changed' | 'orphaned';

export type ThreadStatus = 'open' | 'resolved';

export type AuthorKind = 'human' | 'agent';

export interface Comment {
  id: number;
  threadId: number;
  author: string;
  authorKind: AuthorKind;
  body: string;
  createdAt: string;
  /** Null unless the body has been rewritten since. */
  editedAt: string | null;
}

export type EventKind =
  | 'created'
  | 'drift'
  | 'staged'
  | 'unstaged'
  | 'committed'
  | 'resolved'
  | 'unresolved';

export interface ThreadEvent {
  id: number;
  threadId: number;
  kind: EventKind;
  /** Free-form per kind; `drift` carries { from, to, before, after }. */
  detail: Record<string, unknown>;
  at: string;
}

/** Lines of a file version, with the numbers they occupied. */
export interface Snippet {
  start: number;
  end: number;
  /** Empty when the region was deleted outright. */
  lines: string[];
}

/** Identifies what a note is saying; a UI translates from this, not from `text`. */
export type NoteCode =
  | 'renamed'
  | 'moved'
  | 'edited'
  | 'deleted'
  | 'orphaned'
  | 'staged'
  | 'replacement-staged'
  | 'committed'
  | 'worktree-diverged'
  | 'snapshot-missing';

export interface Note {
  code: NoteCode;
  /** English rendering. */
  text: string;
  args?: Record<string, string | number>;
}

export interface ThreadAnchor {
  /** Content hash of the file version the comment was written against. */
  blob: string;
  start: number;
  end: number;
  lines: string[];
  /** The `@@ ... @@` header of the hunk the comment landed in. */
  hunkHeader: string | null;
}

export interface ThreadCurrent {
  drift: Drift;
  /** Null when orphaned. When the region was deleted, `end` < `start`. */
  region: Snippet | null;
  /** Drift against each of the three file versions. */
  locations: Record<Version, Drift>;
  /** What changed. */
  notes: Note[];
  checkedAt: string;
}

export interface Thread {
  id: number;
  filePath: string;
  side: Side;
  target: DiffTarget;
  status: ThreadStatus;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  anchor: ThreadAnchor;
  current: ThreadCurrent;
  /** `path:start-end` at currently valid line numbers. */
  ref: string;
  comments: Comment[];
  /** Only populated by `show` and `list --events`. */
  events: ThreadEvent[];
}

export interface RepoInfo {
  root: string;
  gitDir: string;
  dbPath: string;
  head: string | null;
  branch: string | null;
}

export interface Stats {
  open: number;
  resolved: number;
  /** Open threads whose anchored lines were edited since. */
  changed: number;
  orphaned: number;
}

/** Envelope for every `--json` response. */
export type CliResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** A command to run when the reviewer presses Submit. Per-worktree. */
export interface Callback {
  name: string;
  command: string;
  createdAt: string;
}

export interface CallbackResult {
  name: string;
  command: string;
  /** Null when the process was killed by a signal or timed out. */
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}
