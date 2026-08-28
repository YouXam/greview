import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Side, Thread } from '../../cli/src/protocol.ts';
import {
  actionFor,
  commentLabel,
  driftSuffix,
  needsBanner,
  placeLabel,
  splitNotes,
  threadDescription,
  threadLabel,
  type Translate,
} from '../src/labels.ts';

/** Identity translator: assertions read as the English source strings. */
const tr: Translate = (text, ...args) => text.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)]));

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 1,
    filePath: 'src/a.rs',
    side: 'new',
    target: 'worktree',
    status: 'open',
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
    resolvedAt: null,
    resolvedBy: null,
    anchor: { blob: 'x', start: 10, end: 10, lines: ['line'], hunkHeader: null },
    current: {
      drift: 'current',
      region: { start: 10, end: 10, lines: ['line'] },
      locations: { worktree: 'current', index: 'changed', head: 'changed' },
      notes: [],
      checkedAt: '2026-08-10T00:00:00.000Z',
    },
    ref: 'src/a.rs:10',
    comments: [],
    events: [],
    ...overrides,
  };
}

const sides: Side[] = ['new', 'old'];

test('two threads differing only by side never render the same', () => {
  const [a, b] = sides.map((side) => thread({ side }));
  assert.notEqual(threadDescription(a!, tr), threadDescription(b!, tr));
  assert.notEqual(threadLabel(a!, tr), threadLabel(b!, tr));
  assert.notEqual(placeLabel(a!, tr), placeLabel(b!, tr));
});

test('the side is named in both the list description and the widget header', () => {
  for (const side of sides) {
    const t = thread({ side });
    const expected = side === 'new' ? 'new side' : 'old side';
    assert.ok(threadDescription(t, tr).includes(expected), threadDescription(t, tr));
    assert.ok(threadLabel(t, tr).includes(expected), threadLabel(t, tr));
  }
});

test('the side precedes the diff name, so truncation cannot hide it', () => {
  const t = thread({ side: 'old', target: 'index' });
  const text = threadDescription(t, tr);
  assert.ok(text.indexOf('old side') < text.indexOf('staged'), text);
});

test('the description reports the current line, not the anchor line', () => {
  const moved = thread({
    anchor: { blob: 'x', start: 10, end: 10, lines: ['line'], hunkHeader: null },
    current: {
      drift: 'moved',
      region: { start: 42, end: 42, lines: ['line'] },
      locations: { worktree: 'moved', index: 'changed', head: 'changed' },
      notes: [],
      checkedAt: '2026-08-10T00:00:00.000Z',
    },
  });
  assert.match(threadDescription(moved, tr), /^L42 /);
  assert.doesNotMatch(
    threadDescription(moved, tr),
    /moved/,
    'following the code is not worth announcing',
  );
});

test('an orphaned thread falls back to the anchor line rather than showing nothing', () => {
  const orphan = thread({
    current: {
      drift: 'orphaned',
      region: null,
      locations: { worktree: 'orphaned', index: 'orphaned', head: 'orphaned' },
      notes: [],
      checkedAt: '2026-08-10T00:00:00.000Z',
    },
  });
  assert.match(threadDescription(orphan, tr), /^L10 /);
  assert.match(threadDescription(orphan, tr), /file gone/);
});

test('every diff target has a distinct name', () => {
  const names = (['worktree', 'index', 'head'] as const).map((target) =>
    placeLabel(thread({ target }), tr),
  );
  assert.equal(new Set(names).size, 3, names.join(' | '));
});

function comment(overrides: Partial<Thread['comments'][number]> = {}): Thread['comments'][number] {
  return {
    id: 1,
    threadId: 1,
    author: 'YouXam',
    authorKind: 'human',
    body: 'why?',
    createdAt: '2026-08-10T00:00:00.000Z',
    editedAt: null,
    ...overrides,
  };
}

test('only the old side is tagged, so the common case stays unlabelled', () => {
  assert.equal(commentLabel(thread({ side: 'new' }), comment(), tr), undefined);
  assert.equal(commentLabel(thread({ side: 'old' }), comment(), tr), 'old side');
});

test('an agent is not tagged, because its author name already says so', () => {
  const byAgent = comment({ author: 'claude', authorKind: 'agent' });
  assert.equal(commentLabel(thread({ side: 'new' }), byAgent, tr), undefined);
  assert.equal(commentLabel(thread({ side: 'old' }), byAgent, tr), 'old side');
});

test('the side tag combines with the edited marker', () => {
  const edited = comment({ editedAt: '2026-08-10T01:00:00.000Z' });
  assert.equal(commentLabel(thread({ side: 'old' }), edited, tr), 'old side · edited');
  assert.equal(commentLabel(thread({ side: 'new' }), edited, tr), 'edited');
});

test('the drift headline and the bullet list never say the same thing', () => {
  const notes: Thread['current']['notes'] = [
    { code: 'edited', text: 'the commented lines were edited' },
    { code: 'replacement-staged', text: 'the lines that replaced them are staged' },
  ];
  const { primary, rest } = splitNotes(notes);
  assert.equal(primary?.code, 'edited');
  assert.deepEqual(rest.map((n) => n.code), ['replacement-staged']);
});

test('a note that only adds context is never promoted to the headline', () => {
  const { primary, rest } = splitNotes([
    { code: 'staged', text: 'content is now staged' },
    { code: 'committed', text: 'content is now committed in HEAD' },
  ]);
  assert.equal(primary, null, 'nothing describes drift, so there is no headline');
  assert.equal(rest.length, 2);
});

test('splitting an empty note list is harmless', () => {
  assert.deepEqual(splitNotes([]), { primary: null, rest: [] });
});

test('clearing hooks is only offered once nothing is left open', () => {
  for (const batch of [true, false]) {
    assert.equal(
      actionFor({ hooks: 1, open: 2, total: 3, batch }),
      batch ? 'submit' : null,
      `open comments must never offer clear (batch=${batch})`,
    );
  }
  assert.equal(actionFor({ hooks: 1, open: 0, total: 3, batch: false }), 'clear');
  assert.equal(actionFor({ hooks: 1, open: 0, total: 3, batch: true }), 'clear');
});

test('submitting is only offered when hooks are held back', () => {
  assert.equal(actionFor({ hooks: 2, open: 1, total: 1, batch: true }), 'submit');
  assert.equal(
    actionFor({ hooks: 2, open: 1, total: 1, batch: false }),
    null,
    'hooks already ran per comment, so there is nothing to submit',
  );
});

test('no hooks and no threads mean no rows at all', () => {
  assert.equal(actionFor({ hooks: 0, open: 5, total: 5, batch: true }), null);
  assert.equal(actionFor({ hooks: 3, open: 0, total: 0, batch: true }), null);
});

test('a shifted anchor is silent: no suffix and no banner', () => {
  const shifted = thread({
    current: {
      drift: 'moved',
      region: { start: 42, end: 42, lines: ['line'] },
      locations: { worktree: 'moved', index: 'changed', head: 'changed' },
      notes: [],
      checkedAt: '2026-08-12T00:00:00.000Z',
    },
  });
  assert.equal(driftSuffix(shifted, tr), '');
  assert.equal(needsBanner(shifted), false);
  // The position is still reported, just not as news.
  assert.match(threadDescription(shifted, tr), /^L42 /);
});

test('a shifted anchor still speaks up when something else happened to it', () => {
  const stagedAndShifted = thread({
    current: {
      drift: 'moved',
      region: { start: 42, end: 42, lines: ['line'] },
      locations: { worktree: 'moved', index: 'moved', head: 'changed' },
      notes: [{ code: 'staged', text: 'content is now staged' }],
      checkedAt: '2026-08-12T00:00:00.000Z',
    },
  });
  assert.equal(needsBanner(stagedAndShifted), true);
});

test('an edited or orphaned anchor always shows a banner', () => {
  for (const drift of ['changed', 'orphaned'] as const) {
    const t = thread({
      current: {
        drift,
        region: drift === 'changed' ? { start: 10, end: 10, lines: ['new'] } : null,
        locations: { worktree: drift, index: drift, head: drift },
        notes: [],
        checkedAt: '2026-08-12T00:00:00.000Z',
      },
    });
    assert.equal(needsBanner(t), true, drift);
    assert.notEqual(driftSuffix(t, tr), '', drift);
  }
});
