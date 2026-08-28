import type { Comment, DiffTarget, Note, NoteCode, Side, Thread } from '@greview/protocol';

export type Translate = (text: string, ...args: (string | number)[]) => string;

export function targetLabel(target: DiffTarget, t: Translate): string {
  switch (target) {
    case 'worktree':
      return t('unstaged');
    case 'index':
      return t('staged');
    case 'head':
      return t('HEAD → working tree');
  }
}

export function sideLabel(side: Side, t: Translate): string {
  return side === 'new' ? t('new side') : t('old side');
}

/** Renders a note in the display language, from its code and arguments. */
export function noteText(note: Note, t: Translate): string {
  const arg = (key: string): string => String(note.args?.[key] ?? '');
  switch (note.code) {
    case 'renamed':
      return t('File renamed to {0}.', arg('path'));
    case 'moved':
      return t('The commented lines moved to {0}-{1}.', arg('start'), arg('end'));
    case 'edited':
      return t('The commented lines were edited.');
    case 'deleted':
      return t('The commented lines were deleted.');
    case 'orphaned':
      return t('{0} no longer exists in the {1} version.', arg('path'), arg('version'));
    case 'staged':
      return t('This content is now staged.');
    case 'replacement-staged':
      return t('The lines that replaced them are staged.');
    case 'committed':
      return t('This content is now committed in HEAD.');
    case 'worktree-diverged':
      return t('The working tree has since diverged from this content.');
    case 'snapshot-missing':
      return t('The stored snapshot of this file is missing from the database.');
    default:
      // A newer CLI may know codes this build does not.
      return note.text;
  }
}

/** Empty for `current` and `moved`: the positions shown are already the new ones. */
export function driftSuffix(thread: Thread, t: Translate): string {
  switch (thread.current.drift) {
    case 'changed':
      return thread.current.region && thread.current.region.end < thread.current.region.start
        ? ` · ${t('lines deleted since')}`
        : ` · ${t('lines edited since')}`;
    case 'orphaned':
      return ` · ${t('file gone')}`;
    default:
      return '';
  }
}

/** Which diff, and which of its two panes — the pair that fixes the semantics. */
export function placeLabel(thread: Thread, t: Translate): string {
  return `${sideLabel(thread.side, t)} · ${targetLabel(thread.target, t)}`;
}

/** Header of the comment widget in a diff editor. */
export function threadLabel(thread: Thread, t: Translate): string {
  return `#${thread.id} · ${placeLabel(thread, t)}${driftSuffix(thread, t)}`;
}

/** Dimmed text beside a list entry. The side leads, because it truncates last. */
export function threadDescription(thread: Thread, t: Translate): string {
  const line = thread.current.region ? thread.current.region.start : thread.anchor.start;
  return `L${line} · ${placeLabel(thread, t)}${driftSuffix(thread, t)}`;
}

/**
 * Tag beside a comment's author; the only field of ours the built-in Comments
 * panel shows. Undefined for the new side, which needs no marking.
 */
export function commentLabel(thread: Thread, comment: Comment, t: Translate): string | undefined {
  const parts: string[] = [];
  if (thread.side === 'old') parts.push(sideLabel('old', t));
  if (comment.editedAt !== null) parts.push(t('edited'));
  return parts.length === 0 ? undefined : parts.join(' · ');
}

/** Notes that state what happened to the lines; the rest add context. */
const DRIFT_NOTES = new Set<NoteCode>(['edited', 'deleted', 'orphaned', 'snapshot-missing']);

/** Separates the note that states what happened from the ones that add to it. */
export function splitNotes(notes: Note[]): { primary: Note | null; rest: Note[] } {
  const primary = notes.find((n) => DRIFT_NOTES.has(n.code)) ?? null;
  return { primary, rest: notes.filter((n) => n !== primary) };
}

export type ActionKind = 'submit' | 'clear';

/** Which action row a repository's review list should offer, if any. */
export function actionFor(input: {
  hooks: number;
  open: number;
  total: number;
  batch: boolean;
}): ActionKind | null {
  if (input.hooks === 0) return null;
  if (input.total > 0 && input.open === 0) return 'clear';
  if (input.open > 0 && input.batch) return 'submit';
  return null;
}

/** Whether a thread has anything to show above its comments. */
export function needsBanner(thread: Thread): boolean {
  if (thread.current.drift === 'current' || thread.current.drift === 'moved') {
    return thread.current.notes.length > 0;
  }
  return true;
}
