import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sqlite } from './sqlite.ts';
import type { AuthorKind, DiffTarget, Drift, EventKind, Side, ThreadStatus, Version } from './protocol.ts';
import type { Repo } from './git.ts';

/** Applied in order; `schema_version` is the count already applied. */
const MIGRATIONS: string[] = [
  `
    CREATE TABLE IF NOT EXISTS blobs (
      sha TEXT PRIMARY KEY,
      content TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS threads (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path    TEXT NOT NULL,
      side         TEXT NOT NULL,
      target       TEXT NOT NULL,
      anchor_blob  TEXT NOT NULL REFERENCES blobs(sha),
      anchor_start INTEGER NOT NULL,
      anchor_end   INTEGER NOT NULL,
      hunk_header  TEXT,
      status       TEXT NOT NULL DEFAULT 'open',
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      resolved_at  TEXT,
      resolved_by  TEXT,
      drift        TEXT,
      cur_start    INTEGER,
      cur_end      INTEGER,
      locations    TEXT,
      checked_at   TEXT
    );
    CREATE INDEX IF NOT EXISTS threads_by_file ON threads(file_path);
    CREATE TABLE IF NOT EXISTS comments (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id   INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      author      TEXT NOT NULL,
      author_kind TEXT NOT NULL,
      body        TEXT NOT NULL,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS comments_by_thread ON comments(thread_id);
    CREATE TABLE IF NOT EXISTS events (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      kind      TEXT NOT NULL,
      detail    TEXT NOT NULL,
      at        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_by_thread ON events(thread_id);
  `,
  'ALTER TABLE threads ADD COLUMN base_locations TEXT',
  'ALTER TABLE comments ADD COLUMN edited_at TEXT',
  `
    CREATE TABLE IF NOT EXISTS onsubmit (
      name       TEXT PRIMARY KEY,
      command    TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `,
];

export interface ThreadRow {
  id: number;
  file_path: string;
  side: Side;
  target: DiffTarget;
  anchor_blob: string;
  anchor_start: number;
  anchor_end: number;
  hunk_header: string | null;
  status: ThreadStatus;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  drift: Drift | null;
  cur_start: number | null;
  cur_end: number | null;
  locations: string | null;
  /** Where the anchored content sat when the thread was created. */
  base_locations: string | null;
  checked_at: string | null;
}

export interface CommentRow {
  id: number;
  thread_id: number;
  author: string;
  author_kind: AuthorKind;
  body: string;
  created_at: string;
  /** Set once a comment has been rewritten, so the UI can say so. */
  edited_at: string | null;
}

export interface CallbackRow {
  name: string;
  command: string;
  created_at: string;
}

export interface EventRow {
  id: number;
  thread_id: number;
  kind: EventKind;
  detail: string;
  at: string;
}

/** node:sqlite returns untyped column bags. */
function one<T>(v: unknown): T | null {
  return (v as T | undefined) ?? null;
}

function many<T>(v: unknown): T[] {
  return v as T[];
}

/** Where a repo's review database lives. Per-worktree, and never in git. */
export function dbPathFor(repo: Repo): string {
  return join(repo.gitDir, 'review', 'comments.sqlite');
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function nowIso(): string {
  return new Date().toISOString();
}

export class Store {
  readonly db: DatabaseSync;
  readonly path: string;

  constructor(repo: Repo) {
    this.path = dbPathFor(repo);
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new (sqlite().DatabaseSync)(this.path);
    // Armed before anything that can contend: the journal-mode change below
    // takes locks, and without a busy handler any collision fails instantly.
    this.db.exec('PRAGMA busy_timeout = 5000');
    // A rollback journal, not WAL. WAL coordinates through a shared-memory
    // file, which network filesystems (NFS, weka, …) do not reliably support,
    // and some of its lock paths fail without consulting the busy handler. A
    // rollback journal needs nothing beyond ordinary file locks, and this
    // database is far too small for WAL to pay. Also converts databases an
    // older greview left in WAL mode.
    this.db.exec('PRAGMA journal_mode = DELETE');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const found = Number(this.getMeta('schema_version') ?? '0');
    if (found > MIGRATIONS.length) {
      throw new Error(
        `database schema v${found} is newer than this greview (v${MIGRATIONS.length}); upgrade the CLI`,
      );
    }
    for (let version = found; version < MIGRATIONS.length; version++) {
      this.db.exec(MIGRATIONS[version]!);
    }
    // The extension watches this file; an unconditional write would look like a change.
    if (found !== MIGRATIONS.length) this.setMeta('schema_version', String(MIGRATIONS.length));
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?')
      .run(key, value, value);
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  /** Bumped on every write. */
  private bumpRevision(): void {
    const next = Number(this.getMeta('revision') ?? '0') + 1;
    this.setMeta('revision', String(next));
  }

  revision(): number {
    return Number(this.getMeta('revision') ?? '0');
  }

  putBlob(content: string): string {
    const sha = sha256(content);
    this.db.prepare('INSERT OR IGNORE INTO blobs (sha, content) VALUES (?, ?)').run(sha, content);
    return sha;
  }

  getBlob(sha: string): string | null {
    const row = this.db.prepare('SELECT content FROM blobs WHERE sha = ?').get(sha) as
      | { content: string }
      | undefined;
    return row ? row.content : null;
  }

  createThread(input: {
    filePath: string;
    side: Side;
    target: DiffTarget;
    content: string;
    start: number;
    end: number;
    hunkHeader: string | null;
    author: string;
    authorKind: AuthorKind;
    body: string;
  }): number {
    const at = nowIso();
    const blob = this.putBlob(input.content);
    const info = this.db
      .prepare(
        `INSERT INTO threads
           (file_path, side, target, anchor_blob, anchor_start, anchor_end, hunk_header,
            status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      )
      .run(
        input.filePath,
        input.side,
        input.target,
        blob,
        input.start,
        input.end,
        input.hunkHeader,
        at,
        at,
      );
    const id = Number(info.lastInsertRowid);
    this.addComment(id, input.author, input.authorKind, input.body);
    this.addEvent(id, 'created', { target: input.target, side: input.side });
    this.bumpRevision();
    return id;
  }

  addComment(threadId: number, author: string, authorKind: AuthorKind, body: string): number {
    const at = nowIso();
    const info = this.db
      .prepare(
        `INSERT INTO comments (thread_id, author, author_kind, body, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(threadId, author, authorKind, body, at);
    this.db.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(at, threadId);
    this.bumpRevision();
    return Number(info.lastInsertRowid);
  }

  /** Rewrites a comment body. Returns the thread it belongs to, or null. */
  editComment(commentId: number, body: string): number | null {
    const row = one<{ thread_id: number }>(
      this.db.prepare('SELECT thread_id FROM comments WHERE id = ?').get(commentId),
    );
    if (row === null) return null;
    const at = nowIso();
    this.db
      .prepare('UPDATE comments SET body = ?, edited_at = ? WHERE id = ?')
      .run(body, at, commentId);
    this.db.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(at, row.thread_id);
    this.bumpRevision();
    return row.thread_id;
  }

  addEvent(threadId: number, kind: EventKind, detail: Record<string, unknown>): void {
    this.db
      .prepare('INSERT INTO events (thread_id, kind, detail, at) VALUES (?, ?, ?, ?)')
      .run(threadId, kind, JSON.stringify(detail), nowIso());
  }

  setStatus(threadId: number, status: ThreadStatus, by: string): void {
    const at = nowIso();
    this.db
      .prepare('UPDATE threads SET status = ?, resolved_at = ?, resolved_by = ?, updated_at = ? WHERE id = ?')
      .run(status, status === 'resolved' ? at : null, status === 'resolved' ? by : null, at, threadId);
    this.addEvent(threadId, status === 'resolved' ? 'resolved' : 'unresolved', { by });
    this.bumpRevision();
  }

  /**
   * Persists a fresh resolution, but only when it differs: the extension watches
   * this file, so an unchanged row must not be stamped.
   */
  saveResolution(
    threadId: number,
    r: { drift: Drift; start: number | null; end: number | null; locations: Record<Version, Drift> },
  ): void {
    const locations = JSON.stringify(r.locations);
    const current = one<{
      drift: Drift | null;
      cur_start: number | null;
      cur_end: number | null;
      locations: string | null;
    }>(
      this.db
        .prepare('SELECT drift, cur_start, cur_end, locations FROM threads WHERE id = ?')
        .get(threadId),
    );
    if (
      current !== null &&
      current.drift === r.drift &&
      current.cur_start === r.start &&
      current.cur_end === r.end &&
      current.locations === locations
    ) {
      return;
    }
    this.db
      .prepare('UPDATE threads SET drift = ?, cur_start = ?, cur_end = ?, locations = ?, checked_at = ? WHERE id = ?')
      .run(r.drift, r.start, r.end, locations, nowIso(), threadId);
  }

  /** Written once, on the first sync. */
  saveBaseLocations(threadId: number, locations: Record<Version, Drift>): void {
    this.db
      .prepare('UPDATE threads SET base_locations = ? WHERE id = ? AND base_locations IS NULL')
      .run(JSON.stringify(locations), threadId);
  }

  deleteThread(threadId: number): boolean {
    const info = this.db.prepare('DELETE FROM threads WHERE id = ?').run(threadId);
    this.bumpRevision();
    return info.changes > 0;
  }

  thread(id: number): ThreadRow | null {
    return one<ThreadRow>(this.db.prepare('SELECT * FROM threads WHERE id = ?').get(id));
  }

  threads(): ThreadRow[] {
    return many<ThreadRow>(
      this.db.prepare('SELECT * FROM threads ORDER BY file_path, anchor_start, id').all(),
    );
  }

  comments(threadId: number): CommentRow[] {
    return many<CommentRow>(
      this.db.prepare('SELECT * FROM comments WHERE thread_id = ? ORDER BY id').all(threadId),
    );
  }

  events(threadId: number): EventRow[] {
    return many<EventRow>(
      this.db.prepare('SELECT * FROM events WHERE thread_id = ? ORDER BY id').all(threadId),
    );
  }

  lastEvent(threadId: number, kind: EventKind): EventRow | null {
    return one<EventRow>(
      this.db
        .prepare('SELECT * FROM events WHERE thread_id = ? AND kind = ? ORDER BY id DESC LIMIT 1')
        .get(threadId, kind),
    );
  }

  callbacks(): CallbackRow[] {
    return many<CallbackRow>(this.db.prepare('SELECT * FROM onsubmit ORDER BY name').all());
  }

  /** Adds or replaces a submit hook, keyed by name. */
  putCallback(name: string, command: string): void {
    this.db
      .prepare(
        `INSERT INTO onsubmit (name, command, created_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET command = excluded.command`,
      )
      .run(name, command, nowIso());
    this.bumpRevision();
  }

  deleteCallback(name: string): boolean {
    const info = this.db.prepare('DELETE FROM onsubmit WHERE name = ?').run(name);
    this.bumpRevision();
    return info.changes > 0;
  }

  clearCallbacks(): number {
    const info = this.db.prepare('DELETE FROM onsubmit').run();
    this.bumpRevision();
    return Number(info.changes);
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}
