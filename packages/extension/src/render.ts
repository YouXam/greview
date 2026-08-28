import * as vscode from 'vscode';
import { l10n } from 'vscode';
import type { Comment, Note, Side, Thread } from '@greview/protocol';
import * as labels from './labels.ts';

const tr: labels.Translate = (text, ...args) => l10n.t(text, ...args);

export const targetLabel = (target: Parameters<typeof labels.targetLabel>[0]): string =>
  labels.targetLabel(target, tr);
export const sideLabel = (side: Side): string => labels.sideLabel(side, tr);
export const noteText = (note: Note): string => labels.noteText(note, tr);
export const driftSuffix = (thread: Thread): string => labels.driftSuffix(thread, tr);
export const threadLabel = (thread: Thread): string => labels.threadLabel(thread, tr);
export const threadDescription = (thread: Thread): string => labels.threadDescription(thread, tr);
export const actionFor = labels.actionFor;
export const needsBanner = labels.needsBanner;
export const commentLabel = (thread: Thread, comment: Comment): string | undefined =>
  labels.commentLabel(thread, comment, tr);

function fence(lines: string[], sign: string): string {
  return lines.map((l) => `${sign}${l}`).join('\n');
}

/**
 * The before/after block shown when the commented lines no longer match what was
 * commented on. Headlined by the drift note, with the remaining notes below.
 */
export function driftMarkdown(thread: Thread): vscode.MarkdownString | null {
  if (!labels.needsBanner(thread)) return null;
  const { primary, rest } = labels.splitNotes(thread.current.notes);
  const md = new vscode.MarkdownString();

  if (primary) md.appendMarkdown(`**${noteText(primary)}**\n\n`);

  if (thread.current.drift === 'orphaned') {
    md.appendMarkdown(`${l10n.t('The lines this comment was written on:')}\n\n`);
    md.appendCodeblock(thread.anchor.lines.join('\n'), 'text');
  } else if (thread.current.drift === 'changed') {
    const region = thread.current.region;
    const before = fence(thread.anchor.lines, '- ');
    const after = region && region.lines.length > 0 ? fence(region.lines, '+ ') : '';
    md.appendMarkdown(`\`\`\`diff\n${[before, after].filter(Boolean).join('\n')}\n\`\`\`\n`);
  }

  for (const note of rest) md.appendMarkdown(`\n- ${noteText(note)}`);
  return md;
}

/** Rich tooltip for the list view. */
export function tooltipFor(t: Thread): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.supportThemeIcons = true;
  md.appendMarkdown(
    `**${t.ref}** · ${l10n.t('{0} diff', targetLabel(t.target))} · ${sideLabel(t.side)}\n\n`,
  );
  if (t.status === 'resolved') {
    md.appendMarkdown(
      `$(check) ${
        t.resolvedBy ? l10n.t('Resolved by {0}', t.resolvedBy) : l10n.t('Resolved')
      }\n\n`,
    );
  }
  for (const note of t.current.notes) md.appendMarkdown(`- ${noteText(note)}\n`);
  const drift = driftMarkdown(t);
  if (drift) md.appendMarkdown(`\n${drift.value}\n`);
  md.appendMarkdown('\n---\n');
  for (const c of t.comments) {
    const who = c.authorKind === 'agent' ? `${c.author} _(${l10n.t('agent')})_` : c.author;
    md.appendMarkdown(`\n**${who}**\n\n${c.body}\n`);
  }
  return md;
}

/** Line range to attach a thread to, in editor (0-based) coordinates. */
export function rangeFor(t: Thread): vscode.Range {
  const region = t.current.region;
  const start = region ? region.start : t.anchor.start;
  const end = region && region.end >= region.start ? region.end : start;
  const line = Math.max(0, start - 1);
  return new vscode.Range(line, 0, Math.max(line, end - 1), 0);
}

/** Everything the views draw from a thread, as one string to compare against. */
export function threadSignature(t: Thread): string {
  return JSON.stringify([
    t.id,
    t.filePath,
    t.ref,
    t.side,
    t.target,
    t.status,
    t.resolvedBy,
    t.current.drift,
    t.current.region,
    t.current.notes.map((n) => [n.code, n.args]),
    t.anchor.start,
    t.anchor.end,
    t.anchor.lines,
    t.comments.map((c) => [c.id, c.author, c.authorKind, c.body, c.createdAt]),
  ]);
}
