import { mapRange, sliceLines, splitLines } from './anchor.ts';
import { readVersion, renameOf, versionFor, type Repo } from './git.ts';
import type { Store, ThreadRow } from './store.ts';
import type {
  Comment,
  Drift,
  Note,
  NoteCode,
  Snippet,
  Thread,
  ThreadEvent,
  Version,
} from './protocol.ts';

const VERSIONS: Version[] = ['worktree', 'index', 'head'];

/** Content survived verbatim, wherever it now sits. */
function intact(d: Drift | undefined): boolean {
  return d === 'current' || d === 'moved';
}

/** Two file versions hold the same text where the anchor now points. */
function sameRegion(a: Snippet | null, b: Snippet | null): boolean {
  return a !== null && b !== null && a.lines.join('\n') === b.lines.join('\n');
}

interface Resolution {
  drift: Drift;
  region: Snippet | null;
  locations: Record<Version, Drift>;
  notes: Note[];
  /** Path the content was followed to, when the file was renamed. */
  renamedTo: string | null;
}

/** Places a thread's anchored lines in each of the three current file versions. */
export function resolveThread(repo: Repo, store: Store, row: ThreadRow): Resolution {
  const anchor = store.getBlob(row.anchor_blob);
  if (anchor === null) {
    return {
      drift: 'orphaned',
      region: null,
      locations: { worktree: 'orphaned', index: 'orphaned', head: 'orphaned' },
      notes: [
        {
          code: 'snapshot-missing',
          text: 'the recorded snapshot of this file is missing from the database',
        },
      ],
      renamedTo: null,
    };
  }

  let path = row.file_path;
  let renamedTo: string | null = null;
  if (readVersion(repo, 'worktree', path) === null) {
    const moved = renameOf(repo, path);
    if (moved && readVersion(repo, 'worktree', moved) !== null) {
      renamedTo = moved;
      path = moved;
    }
  }

  const locations = {} as Record<Version, Drift>;
  const regions = {} as Record<Version, Snippet | null>;
  for (const v of VERSIONS) {
    // A rename only affects the working tree; the index and HEAD keep the old name.
    const readPath = v === 'worktree' ? path : row.file_path;
    const content = readVersion(repo, v, readPath);
    if (content === null) {
      locations[v] = 'orphaned';
      regions[v] = null;
      continue;
    }
    const m = mapRange(anchor, content, row.anchor_start, row.anchor_end);
    locations[v] = m.drift;
    regions[v] = { start: m.start, end: m.end, lines: sliceLines(content, m.start, m.end) };
  }

  const primary = versionFor(row.target, row.side);
  const drift = locations[primary]!;
  const region = regions[primary]!;

  // Measured against creation time: a line already in HEAD then is not news now.
  const baseline: Record<Version, Drift> | null = row.base_locations
    ? (JSON.parse(row.base_locations) as Record<Version, Drift>)
    : null;
  const wasIntact = (v: Version): boolean => intact(baseline === null ? locations[v] : baseline[v]);

  const notes: Note[] = [];
  const note = (code: NoteCode, text: string, args?: Record<string, string | number>): void => {
    notes.push(args ? { code, text, args } : { code, text });
  };

  if (renamedTo) note('renamed', `file renamed to ${renamedTo}`, { path: renamedTo });
  // No note for `moved`: the content is identical and `ref` carries the position.
  if (drift === 'changed') {
    if (region!.end < region!.start) note('deleted', 'the commented lines were deleted');
    else note('edited', 'the commented lines were edited');
  }
  if (drift === 'orphaned') {
    note('orphaned', `${row.file_path} does not exist in the ${primary} version`, {
      path: row.file_path,
      version: primary,
    });
  }
  if (row.side === 'new' && row.target === 'worktree') {
    if (intact(locations.index)) {
      if (!wasIntact('index')) note('staged', 'content is now staged');
    } else if (sameRegion(regions.worktree, regions.index)) {
      note('replacement-staged', 'the lines that replaced them are staged');
    }
  }
  if (row.side === 'new' && intact(locations.head) && !wasIntact('head')) {
    note('committed', 'content is now committed in HEAD');
  }
  if (row.side === 'new' && row.target !== 'worktree' && !intact(locations.worktree) && drift !== 'orphaned') {
    note('worktree-diverged', 'the working tree has since diverged from this content');
  }

  return { drift, region, locations, notes, renamedTo };
}

/** Re-resolves a thread and records what changed since the last check. */
export function syncThread(repo: Repo, store: Store, row: ThreadRow): Resolution {
  const r = resolveThread(repo, store, row);
  const prev: Record<Version, Drift> | null = row.locations
    ? (JSON.parse(row.locations) as Record<Version, Drift>)
    : null;

  if (row.base_locations === null) store.saveBaseLocations(row.id, r.locations);

  if (row.drift !== null && row.drift !== r.drift) {
    const anchorLines = splitLines(store.getBlob(row.anchor_blob) ?? '').slice(
      row.anchor_start - 1,
      row.anchor_end,
    );
    store.addEvent(row.id, 'drift', {
      from: row.drift,
      to: r.drift,
      before: anchorLines,
      after: r.region ? r.region.lines : [],
      beforeRange: [row.anchor_start, row.anchor_end],
      afterRange: r.region ? [r.region.start, r.region.end] : null,
    });
  }
  if (prev) {
    if (!intact(prev.index) && intact(r.locations.index)) {
      store.addEvent(row.id, 'staged', { drift: r.locations.index });
    } else if (intact(prev.index) && !intact(r.locations.index)) {
      store.addEvent(row.id, 'unstaged', { drift: r.locations.index });
    }
    if (!intact(prev.head) && intact(r.locations.head)) {
      store.addEvent(row.id, 'committed', { drift: r.locations.head });
    }
  }

  store.saveResolution(row.id, {
    drift: r.drift,
    start: r.region ? r.region.start : null,
    end: r.region ? r.region.end : null,
    locations: r.locations,
  });
  return r;
}

export function syncAll(repo: Repo, store: Store): Map<number, Resolution> {
  const out = new Map<number, Resolution>();
  store.transaction(() => {
    for (const row of store.threads()) out.set(row.id, syncThread(repo, store, row));
  });
  return out;
}

/** Builds the wire object for a thread, using an already-computed resolution. */
export function toThread(
  store: Store,
  row: ThreadRow,
  r: Resolution,
  opts: { events?: boolean } = {},
): Thread {
  const anchorText = store.getBlob(row.anchor_blob) ?? '';
  const anchorLines = splitLines(anchorText).slice(row.anchor_start - 1, row.anchor_end);
  const comments: Comment[] = store.comments(row.id).map((c) => ({
    id: c.id,
    threadId: c.thread_id,
    author: c.author,
    authorKind: c.author_kind,
    body: c.body,
    createdAt: c.created_at,
    editedAt: c.edited_at,
  }));
  const events: ThreadEvent[] = opts.events
    ? store.events(row.id).map((e) => ({
        id: e.id,
        threadId: e.thread_id,
        kind: e.kind,
        detail: JSON.parse(e.detail) as Record<string, unknown>,
        at: e.at,
      }))
    : [];

  const displayPath = r.renamedTo ?? row.file_path;
  const ref = r.region
    ? `${displayPath}:${r.region.start}${r.region.end > r.region.start ? `-${r.region.end}` : ''}`
    : `${row.file_path}:${row.anchor_start}${row.anchor_end > row.anchor_start ? `-${row.anchor_end}` : ''}`;

  return {
    id: row.id,
    filePath: displayPath,
    side: row.side,
    target: row.target,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    anchor: {
      blob: row.anchor_blob,
      start: row.anchor_start,
      end: row.anchor_end,
      lines: anchorLines,
      hunkHeader: row.hunk_header,
    },
    current: {
      drift: r.drift,
      region: r.region,
      locations: r.locations,
      notes: r.notes,
      checkedAt: row.checked_at ?? new Date().toISOString(),
    },
    ref,
    comments,
    events,
  };
}
