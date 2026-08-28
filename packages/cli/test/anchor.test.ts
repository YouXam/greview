import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { lineMap, mapRange, sliceLines, splitLines } from '../src/anchor.ts';

const lines = (...l: string[]) => `${l.join('\n')}\n`;

test('splitLines does not invent a line for the trailing newline', () => {
  assert.deepEqual(splitLines('a\nb\n'), ['a', 'b']);
  assert.deepEqual(splitLines('a\nb'), ['a', 'b']);
  assert.deepEqual(splitLines(''), []);
  assert.deepEqual(splitLines('\n'), ['']);
});

test('identical content is current', () => {
  const text = lines('a', 'b', 'c');
  assert.deepEqual(mapRange(text, text, 2, 2), { drift: 'current', start: 2, end: 2 });
});

test('an insertion above the region moves it', () => {
  const before = lines('a', 'b', 'c', 'd');
  const after = lines('a', 'x', 'y', 'b', 'c', 'd');
  assert.deepEqual(mapRange(before, after, 2, 3), { drift: 'moved', start: 4, end: 5 });
});

test('an insertion below the region leaves it current', () => {
  const before = lines('a', 'b', 'c');
  const after = lines('a', 'b', 'c', 'd', 'e');
  assert.deepEqual(mapRange(before, after, 1, 2), { drift: 'current', start: 1, end: 2 });
});

test('editing a line inside the region reports changed with the new span', () => {
  const before = lines('a', 'b', 'c', 'd');
  const after = lines('a', 'B!', 'c', 'd');
  assert.deepEqual(mapRange(before, after, 2, 2), { drift: 'changed', start: 2, end: 2 });
});

test('a region that grew reports the span it grew into', () => {
  const before = lines('keep', 'one', 'tail');
  const after = lines('keep', 'one a', 'one b', 'one c', 'tail');
  assert.deepEqual(mapRange(before, after, 2, 2), { drift: 'changed', start: 2, end: 4 });
});

test('a deleted region reports an empty span at the collapse point', () => {
  const before = lines('a', 'gone1', 'gone2', 'd');
  const after = lines('a', 'd');
  const m = mapRange(before, after, 2, 3);
  assert.equal(m.drift, 'changed');
  assert.equal(m.start, 2);
  assert.ok(m.end < m.start, `expected an empty span, got ${m.start}-${m.end}`);
  assert.deepEqual(sliceLines(after, m.start, m.end), []);
});

test('a region deleted from the end of the file collapses too', () => {
  const before = lines('a', 'b', 'c');
  const after = lines('a');
  const m = mapRange(before, after, 2, 3);
  assert.equal(m.drift, 'changed');
  assert.ok(m.end < m.start, `expected an empty span, got ${m.start}-${m.end}`);
});

test('moving a block down tracks it', () => {
  const before = lines('fn a', 'body', 'fn b', 'other');
  const after = lines('fn b', 'other', 'fn a', 'body');
  const m = mapRange(before, after, 1, 2);
  assert.equal(m.drift, 'moved');
  assert.deepEqual(sliceLines(after, m.start, m.end), ['fn a', 'body']);
});

test('a rewritten file does not fabricate a position', () => {
  const before = lines('a', 'b', 'c');
  const after = lines('completely', 'different', 'text');
  const m = mapRange(before, after, 2, 2);
  assert.equal(m.drift, 'changed');
  assert.ok(m.start >= 1 && m.end <= 3);
});

test('the region is clamped to the file it was anchored in', () => {
  const before = lines('a', 'b');
  const after = lines('a', 'b', 'c');
  const m = mapRange(before, after, 5, 9);
  assert.equal(m.drift, 'current');
  assert.equal(m.start, 2);
});

test('lineMap pairs prefix and suffix without the quadratic middle', () => {
  const a = ['1', '2', '3', 'mid', '8', '9'];
  const b = ['1', '2', '3', 'MID', 'MID2', '8', '9'];
  const map = lineMap(a, b);
  assert.equal(map[1], 1);
  assert.equal(map[3], 3);
  assert.equal(map[4], 0, 'the edited line has no counterpart');
  assert.equal(map[5], 6);
  assert.equal(map[6], 7);
});

test('CRLF lines compare exactly', () => {
  const before = 'a\r\nb\r\n';
  const after = 'a\r\nb\r\n';
  assert.equal(mapRange(before, after, 1, 1).drift, 'current');
  assert.equal(mapRange(before, 'a\nb\n', 1, 1).drift, 'changed');
});
