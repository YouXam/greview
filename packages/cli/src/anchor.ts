/** Splits into lines without inventing a trailing empty line for a final "\n". */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Cells of LCS table we are willing to fill before giving up on precision. */
const DP_BUDGET = 2_000_000;

/**
 * Maps every line of `a` to its line in `b`, or 0 when the line has no
 * counterpart. 1-indexed: `map[1]` is the first line of `a`.
 *
 * Over `DP_BUDGET` the middle lines are left unmapped, which yields `changed`.
 */
export function lineMap(a: string[], b: string[]): Int32Array {
  const map = new Int32Array(a.length + 1);
  const max = Math.min(a.length, b.length);

  let prefix = 0;
  while (prefix < max && a[prefix] === b[prefix]) prefix++;

  let suffix = 0;
  while (suffix < max - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;

  for (let i = 0; i < prefix; i++) map[i + 1] = i + 1;
  for (let i = 0; i < suffix; i++) map[a.length - i] = b.length - i;

  const aMid = a.slice(prefix, a.length - suffix);
  const bMid = b.slice(prefix, b.length - suffix);
  if (aMid.length === 0 || bMid.length === 0) return map;
  if (aMid.length * bMid.length > DP_BUDGET) return map;

  const w = bMid.length + 1;
  const dp = new Int32Array((aMid.length + 1) * w);
  for (let i = aMid.length - 1; i >= 0; i--) {
    for (let j = bMid.length - 1; j >= 0; j--) {
      dp[i * w + j] =
        aMid[i] === bMid[j]
          ? dp[(i + 1) * w + j + 1]! + 1
          : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < aMid.length && j < bMid.length) {
    if (aMid[i] === bMid[j]) {
      map[prefix + i + 1] = prefix + j + 1;
      i++;
      j++;
    } else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) {
      i++;
    } else {
      j++;
    }
  }
  return map;
}

export interface RangeMapping {
  drift: 'current' | 'moved' | 'changed';
  start: number;
  /** Less than `start` when the region was deleted outright. */
  end: number;
}

/** 1-based start lines where `block` appears verbatim in `b`. */
function findBlock(b: string[], block: string[], limit: number): number[] {
  const out: number[] = [];
  if (block.length === 0 || block.length > b.length) return out;
  for (let i = 0; i + block.length <= b.length; i++) {
    let hit = true;
    for (let k = 0; k < block.length && hit; k++) hit = b[i + k] === block[k];
    if (hit) {
      out.push(i + 1);
      if (out.length > limit) break;
    }
  }
  return out;
}

/**
 * Locates the `[start, end]` line range of `aText` inside `bText`.
 *
 * For `changed`, the returned range is the span the lines collapsed into, bounded
 * by the nearest surviving line on either side.
 */
export function mapRange(aText: string, bText: string, start: number, end: number): RangeMapping {
  const a = splitLines(aText);
  const b = splitLines(bText);
  const s = Math.max(1, Math.min(start, a.length || 1));
  const e = Math.max(s, Math.min(end, a.length || 1));

  if (aText === bText) return { drift: 'current', start: s, end: e };

  const map = lineMap(a, b);

  let intact = map[s] !== 0;
  for (let l = s; intact && l < e; l++) {
    if (map[l + 1] !== map[l]! + 1) intact = false;
  }
  if (intact) {
    const ns = map[s]!;
    const ne = map[e]!;
    return { drift: ns === s && ne === e ? 'current' : 'moved', start: ns, end: ne };
  }

  // An LCS alignment reads a relocated block as a deletion plus an insertion, so
  // the block is searched for verbatim before `changed` is accepted.
  const block = a.slice(s - 1, e);
  const found = findBlock(b, block, 4);
  const distinctive = block.length >= 2 || block.join('').trim().length >= 12;
  if (found.length === 1 || (found.length > 1 && found.length <= 4 && distinctive)) {
    let best = found[0]!;
    for (const o of found) {
      if (Math.abs(o - s) < Math.abs(best - s)) best = o;
    }
    return { drift: 'moved', start: best, end: best + block.length - 1 };
  }

  let ns = 0;
  for (let l = s - 1; l >= 1; l--) {
    if (map[l]) {
      ns = map[l]! + 1;
      break;
    }
  }
  if (ns === 0) ns = 1;

  let ne = 0;
  for (let l = e + 1; l <= a.length; l++) {
    if (map[l]) {
      ne = map[l]! - 1;
      break;
    }
  }
  if (ne === 0) ne = b.length;

  return { drift: 'changed', start: ns, end: ne };
}

/** Extracts an inclusive 1-based line range; empty when `end` < `start`. */
export function sliceLines(text: string, start: number, end: number): string[] {
  if (end < start) return [];
  return splitLines(text).slice(Math.max(0, start - 1), end);
}
