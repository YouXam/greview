import type { DiffTarget, Drift, Side, Thread, ThreadEvent } from './protocol.ts';

const useColor =
  process.stdout.isTTY === true && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb';

const wrap = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const dim = wrap('2');
export const bold = wrap('1');
export const red = wrap('31');
export const green = wrap('32');
export const yellow = wrap('33');
export const blue = wrap('34');
export const magenta = wrap('35');
export const cyan = wrap('36');

const DRIFT_LABEL: Record<Drift, string> = {
  current: 'current',
  moved: 'moved',
  changed: 'changed',
  orphaned: 'orphaned',
};

export function driftBadge(d: Drift): string {
  const label = DRIFT_LABEL[d];
  if (d === 'current') return green(label);
  // Dim, not coloured: a shifted anchor is a fact, not something to look at.
  if (d === 'moved') return dim(label);
  if (d === 'changed') return yellow(`! ${label}`);
  return red(`! ${label}`);
}

const TARGET_LABEL: Record<DiffTarget, string> = {
  worktree: 'unstaged diff',
  index: 'staged diff',
  head: 'HEAD..worktree diff',
};

export function targetLabel(t: DiffTarget): string {
  return TARGET_LABEL[t];
}

export function sideLabel(s: Side): string {
  return s === 'new' ? 'new side' : 'old side';
}

/** Which diff, and which of its two panes — the pair that fixes the semantics. */
function placeLabel(t: Thread): string {
  return `${targetLabel(t.target)} · ${sideLabel(t.side)}`;
}

function firstLine(body: string): string {
  const line = body.split('\n')[0] ?? '';
  return line.length > 72 ? `${line.slice(0, 71)}…` : line;
}

function gutter(lines: string[], start: number, sign: string, paint: (s: string) => string): string[] {
  if (lines.length === 0) return [`      ${dim('(no lines — region deleted)')}`];
  const width = String(start + lines.length - 1).length;
  return lines.map((l, i) => {
    const n = String(start + i).padStart(width);
    return `   ${dim(n)} ${dim('│')} ${paint(`${sign}${l}`)}`;
  });
}

/** One-line summary used by `list`. */
export function threadLine(t: Thread): string {
  const status = t.status === 'resolved' ? green('resolved') : bold('open');
  const head = `${magenta(`#${t.id}`)} ${cyan(t.ref)}`;
  const meta = [status, driftBadge(t.current.drift), dim(placeLabel(t))].join(' ');
  const who = t.comments[0]?.author ?? '?';
  const n = t.comments.length > 1 ? dim(` (+${t.comments.length - 1})`) : '';
  return `${head}  ${meta}\n    ${dim(`${who}:`)} ${firstLine(t.comments[0]?.body ?? '')}${n}`;
}

export function eventLine(e: ThreadEvent): string {
  const at = dim(e.at.replace('T', ' ').slice(0, 19));
  switch (e.kind) {
    case 'drift':
      return `${at} ${yellow('drift')} ${e.detail.from as string} → ${e.detail.to as string}`;
    case 'staged':
      return `${at} ${blue('staged')} the commented content entered the index`;
    case 'unstaged':
      return `${at} ${blue('unstaged')} the commented content left the index`;
    case 'committed':
      return `${at} ${blue('committed')} the commented content is in HEAD`;
    case 'resolved':
      return `${at} ${green('resolved')} by ${e.detail.by as string}`;
    case 'unresolved':
      return `${at} ${yellow('reopened')} by ${e.detail.by as string}`;
    default:
      return `${at} ${e.kind}`;
  }
}

/** Full rendering used by `show`. */
export function threadDetail(t: Thread): string {
  const out: string[] = [];
  const status = t.status === 'resolved' ? green('resolved') : bold('open');
  out.push(
    `${magenta(`#${t.id}`)} ${cyan(t.ref)}  ${status}  ${driftBadge(t.current.drift)}  ${dim(
      placeLabel(t),
    )}`,
  );
  for (const note of t.current.notes) out.push(`   ${yellow('•')} ${note.text}`);
  if (t.anchor.hunkHeader) out.push(`   ${dim(t.anchor.hunkHeader)}`);
  out.push('');

  if (t.current.drift === 'current' || t.current.drift === 'moved') {
    // Identical content: one block, at the line numbers it occupies now.
    const region = t.current.region;
    const start = region ? region.start : t.anchor.start;
    const end = region ? region.end : t.anchor.end;
    out.push(`  ${bold('commented lines')} ${dim(`(lines ${start}-${end})`)}`);
    out.push(...gutter(region ? region.lines : t.anchor.lines, start, ' ', (s) => s));
  } else {
    out.push(`  ${bold('when commented')} ${dim(`(lines ${t.anchor.start}-${t.anchor.end})`)}`);
    out.push(...gutter(t.anchor.lines, t.anchor.start, t.current.drift === 'changed' ? '-' : ' ', red));
    out.push('');
    if (t.current.region) {
      const r = t.current.region;
      out.push(`  ${bold('now')} ${dim(`(lines ${r.start}-${r.end})`)}`);
      out.push(...gutter(r.lines, r.start, t.current.drift === 'changed' ? '+' : ' ', green));
    } else {
      out.push(`  ${bold('now')} ${red('the file is gone')}`);
    }
  }

  out.push('');
  out.push(`  ${dim('── comments ──')}`);
  for (const c of t.comments) {
    const kind = c.authorKind === 'agent' ? dim(' (agent)') : '';
    const edited = c.editedAt === null ? '' : dim(' · edited');
    const at = dim(c.createdAt.replace('T', ' ').slice(0, 19));
    out.push(`  ${bold(c.author)}${kind} ${at} ${dim(`· comment #${c.id}`)}${edited}`);
    for (const line of c.body.split('\n')) out.push(`    ${line}`);
  }

  const interesting = t.events.filter((e) => e.kind !== 'created');
  if (interesting.length > 0) {
    out.push('');
    out.push(`  ${dim('── history ──')}`);
    for (const e of interesting) out.push(`  ${eventLine(e)}`);
  }
  return out.join('\n');
}
