// A faster drop-in for makefun-diff 1.0.0 (make.fun's line diff + patch), written from its documented rule:
// the same tokenizer, the same common prefix/suffix trim, the same Myers greedy search with the deletion-first
// tie-break, and the same patch writer. Everything the rule fixes is kept — the answer must be the oracle's byte for
// byte, so no shortcut may change which of the equally short scripts wins. Only the shapes of the data change:
//   1. lines are interned to ids once, so comparing two lines is comparing two integers;
//   2. the frontier and the per-layer trace are 16-bit arrays whenever the two texts fit 65 532 lines between them
//      (both the ids and the positions fit), which halves the bytes the diagonal loop touches; a longer text uses a
//      32-bit copy of the same loop, and the two copies exist separately on purpose (below);
//   3. both id sequences carry two sentinel ids past their end, so the walk along equal lines is a bare compare with
//      no bounds test, and the two sentinels differ so the walk stops at whichever text ends first;
//   4. the sweep is a plain function over locals, not a closure over them: a closure puts the frontier, the trace and
//      the counters in a context object, and every access in the hot loop then pays a context load (3-4x the loop);
//   5. the 16-bit and the 32-bit loops are written out twice rather than sharing one body, because a body that
//      receives either array type pays a map check on every element touch;
//   6. each layer's diagonal loop carries its frontier index in a register instead of recomputing an offset per step,
//      and its two end diagonals (pure insertion, pure deletion) are lifted out of the bulk loop;
//   7. one packed window per layer is kept, so the edit script is rebuilt from the trace without per-step allocation.

export const FORMAT = 'makefun-diff/1';

/** The kept lines a hunk shows before and after each change run. */
const CONTEXT = 3;

const KEEP = 0;
const DELETE = 1;
const INSERT = 2;

const KEEP_OP = '=';
const DELETE_OP = '-';
const INSERT_OP = '+';

/** A text's lines, each with its "\n" (the last one without, when the text does not end in one). */
function tokenize(text) {
  const parts = text.split('\n');
  const last = parts.length - 1;
  if (parts[last] === '') return parts.slice(0, last).map((part) => part + '\n');
  const lines = new Array(last + 1);
  for (let i = 0; i < last; i++) lines[i] = parts[i] + '\n';
  lines[last] = parts[last];
  return lines;
}

/** The lines of [from, to) as 32-bit line ids, interning each new line in ids. */
function intern(lines, from, to, ids) {
  const out = new Int32Array(to - from);
  for (let i = from; i < to; i++) {
    const line = lines[i];
    let id = ids.get(line);
    if (id === undefined) {
      id = ids.size;
      ids.set(line, id);
    }
    out[i - from] = id;
  }
  return out;
}

/**
 * The Myers sweep over 16-bit positions.
 *
 * The frontier holds the furthest old-text position reached on each diagonal, and the trace holds that same position
 * per (layer, diagonal) so the edit script is rebuilt afterwards. Both are Uint16Array arrays: with at most 65 532 lines
 * between the two texts every position and every line id fits, and a longer text takes the 32-bit copy below.
 */
function editRuns16(idsA, idsB) {
  const n = idsA.length;
  const m = idsB.length;
  const kinds = [];
  const counts = [];
  if (n === 0 && m === 0) return { kinds, counts };

  // 两条 id 序列尾部各补两个哨兵：走等高行时就是一次裸比较，不必每步判边界。
  const a = new Uint16Array(n + 2);
  a.set(idsA);
  a[n] = 65534;
  a[n + 1] = 65534;
  const b = new Uint16Array(m + 2);
  b.set(idsB);
  b[m] = 65533;
  b[m + 1] = 65533;

  const NONE = 65535;
  const max = n + m;
  const off = max + 1;
  const v = new Uint16Array(2 * max + 3).fill(NONE);
  v[off + 1] = 0;

  // 第 d 层只有 k = -d, -d+2, ..., d，打包在 [base(d) + (k + d) / 2]，base(d) = d (d + 1) / 2。
  let trace = new Uint16Array(1 << 16);
  let found = -1;
  let baseD = 0;

  for (let d = 0; d <= max; d++) {
    const need = baseD + d + 1;
    if (need > trace.length) {
      let grown = trace.length * 2;
      while (grown < need) grown *= 2;
      const next = new Uint16Array(grown);
      next.set(trace);
      trace = next;
    }
    if (d === 0) {
      let x = 0;
      while (a[x] === b[x]) x++;
      v[off] = x;
      trace[0] = x;
      if (x >= n && x >= m) {
        found = 0;
        break;
      }
      baseD += 1;
      continue;
    }

    let slot = baseD;
    const half = d + 1;

    // k = -d：只有插入，从上一层 k+1 来
    {
      const k = -d;
      const i = off - d;
      const insX = v[i + 1];
      if (insX === NONE || insX - 1 - k >= m) {
        v[i] = NONE;
        trace[slot] = NONE;
      } else {
        let x = insX;
        let y = x - k;
        while (a[x] === b[y]) {
          x++;
          y++;
        }
        v[i] = x;
        trace[slot] = x;
        if (x >= n && y >= m) found = d;
      }
      slot++;
    }

    // 中间的对角线：两个来源都可能有路，深者胜，一样深时取删除
    for (let k = -d + 2, i = off - d + 2; k <= d - 2; k += 2, i += 2, slot++) {
      const delX = v[i - 1];
      const insX = v[i + 1];
      let x;
      if (delX !== NONE && delX < n) {
        if (insX !== NONE && insX - 1 - k < m && insX - 1 > delX) x = insX;
        else x = delX + 1;
      } else if (insX !== NONE && insX - 1 - k < m) {
        x = insX;
      } else {
        v[i] = NONE;
        trace[slot] = NONE;
        continue;
      }
      let y = x - k;
      while (a[x] === b[y]) {
        x++;
        y++;
      }
      v[i] = x;
      trace[slot] = x;
      if (x >= n && y >= m) found = d;
    }

    // k = d：只有删除，从上一层 k-1 来
    if (found < 0) {
      const k = d;
      const i = off + d;
      const delX = v[i - 1];
      if (delX === NONE || delX >= n) {
        v[i] = NONE;
        trace[slot] = NONE;
      } else {
        let x = delX + 1;
        let y = x - k;
        while (a[x] === b[y]) {
          x++;
          y++;
        }
        v[i] = x;
        trace[slot] = x;
        if (x >= n && y >= m) found = d;
      }
    }

    if (found >= 0) break;
    baseD += half;
  }
  if (found < 0) throw new Error('makefun-diff: the search ended without reaching both ends');

  // 沿轨迹回溯，从尾到头收集脚本
  let x = n;
  let y = m;
  const backKinds = [];
  const backCounts = [];
  let backBase = ((found - 1) * found) >> 1;
  for (let d = found; d > 0; d--) {
    const k = x - y;
    const pd = d - 1;
    const delSlot = k - 1 + pd;
    const insSlot = k + 1 + pd;
    const delX = delSlot >= 0 && delSlot <= 2 * pd ? trace[backBase + (delSlot >> 1)] : NONE;
    const insX = insSlot >= 0 && insSlot <= 2 * pd ? trace[backBase + (insSlot >> 1)] : NONE;
    const canDelete = delX !== NONE && delX < n;
    const canInsert = insX !== NONE && insX - 1 - k < m;
    const byInsertion = canInsert ? insX - 1 : -2;
    const deleted = canDelete && delX >= byInsertion;
    const from = deleted ? delX + 1 : insX;
    if (x > from) {
      backKinds.push(KEEP);
      backCounts.push(x - from);
    }
    backKinds.push(deleted ? DELETE : INSERT);
    backCounts.push(1);
    if (deleted) {
      x = delX;
      y = delX - k + 1;
    } else {
      x = insX;
      y = insX - k - 1;
    }
    backBase -= pd;
    if (backBase < 0) backBase = 0;
  }
  if (x > 0) {
    backKinds.push(KEEP);
    backCounts.push(x);
  }

  let lastKind = -1;
  for (let i = backKinds.length - 1; i >= 0; i--) {
    const kind = backKinds[i];
    const count = backCounts[i];
    if (lastKind === kind) counts[counts.length - 1] += count;
    else {
      kinds.push(kind);
      counts.push(count);
      lastKind = kind;
    }
  }
  return { kinds, counts };
}
/**
 * The Myers sweep over 32-bit positions, for a text too long for the 16-bit copy.
 *
 * The frontier holds the furthest old-text position reached on each diagonal, and the trace holds that same position
 * per (layer, diagonal) so the edit script is rebuilt afterwards. Both are Int32Array arrays: with at most 65 532 lines
 * between the two texts every position and every line id fits, and a longer text takes the 32-bit copy below.
 */
function editRuns32(idsA, idsB) {
  const n = idsA.length;
  const m = idsB.length;
  const kinds = [];
  const counts = [];
  if (n === 0 && m === 0) return { kinds, counts };

  // 两条 id 序列尾部各补两个哨兵：走等高行时就是一次裸比较，不必每步判边界。
  const a = new Int32Array(n + 2);
  a.set(idsA);
  a[n] = -2;
  a[n + 1] = -2;
  const b = new Int32Array(m + 2);
  b.set(idsB);
  b[m] = -3;
  b[m + 1] = -3;

  const NONE = -1;
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3).fill(NONE);
  v[off + 1] = 0;

  // 第 d 层只有 k = -d, -d+2, ..., d，打包在 [base(d) + (k + d) / 2]，base(d) = d (d + 1) / 2。
  let trace = new Int32Array(1 << 16);
  let found = -1;
  let baseD = 0;

  for (let d = 0; d <= max; d++) {
    const need = baseD + d + 1;
    if (need > trace.length) {
      let grown = trace.length * 2;
      while (grown < need) grown *= 2;
      const next = new Int32Array(grown);
      next.set(trace);
      trace = next;
    }
    if (d === 0) {
      let x = 0;
      while (a[x] === b[x]) x++;
      v[off] = x;
      trace[0] = x;
      if (x >= n && x >= m) {
        found = 0;
        break;
      }
      baseD += 1;
      continue;
    }

    let slot = baseD;
    const half = d + 1;

    // k = -d：只有插入，从上一层 k+1 来
    {
      const k = -d;
      const i = off - d;
      const insX = v[i + 1];
      if (insX === NONE || insX - 1 - k >= m) {
        v[i] = NONE;
        trace[slot] = NONE;
      } else {
        let x = insX;
        let y = x - k;
        while (a[x] === b[y]) {
          x++;
          y++;
        }
        v[i] = x;
        trace[slot] = x;
        if (x >= n && y >= m) found = d;
      }
      slot++;
    }

    // 中间的对角线：两个来源都可能有路，深者胜，一样深时取删除
    for (let k = -d + 2, i = off - d + 2; k <= d - 2; k += 2, i += 2, slot++) {
      const delX = v[i - 1];
      const insX = v[i + 1];
      let x;
      if (delX !== NONE && delX < n) {
        if (insX !== NONE && insX - 1 - k < m && insX - 1 > delX) x = insX;
        else x = delX + 1;
      } else if (insX !== NONE && insX - 1 - k < m) {
        x = insX;
      } else {
        v[i] = NONE;
        trace[slot] = NONE;
        continue;
      }
      let y = x - k;
      while (a[x] === b[y]) {
        x++;
        y++;
      }
      v[i] = x;
      trace[slot] = x;
      if (x >= n && y >= m) found = d;
    }

    // k = d：只有删除，从上一层 k-1 来
    if (found < 0) {
      const k = d;
      const i = off + d;
      const delX = v[i - 1];
      if (delX === NONE || delX >= n) {
        v[i] = NONE;
        trace[slot] = NONE;
      } else {
        let x = delX + 1;
        let y = x - k;
        while (a[x] === b[y]) {
          x++;
          y++;
        }
        v[i] = x;
        trace[slot] = x;
        if (x >= n && y >= m) found = d;
      }
    }

    if (found >= 0) break;
    baseD += half;
  }
  if (found < 0) throw new Error('makefun-diff: the search ended without reaching both ends');

  // 沿轨迹回溯，从尾到头收集脚本
  let x = n;
  let y = m;
  const backKinds = [];
  const backCounts = [];
  let backBase = ((found - 1) * found) >> 1;
  for (let d = found; d > 0; d--) {
    const k = x - y;
    const pd = d - 1;
    const delSlot = k - 1 + pd;
    const insSlot = k + 1 + pd;
    const delX = delSlot >= 0 && delSlot <= 2 * pd ? trace[backBase + (delSlot >> 1)] : NONE;
    const insX = insSlot >= 0 && insSlot <= 2 * pd ? trace[backBase + (insSlot >> 1)] : NONE;
    const canDelete = delX !== NONE && delX < n;
    const canInsert = insX !== NONE && insX - 1 - k < m;
    const byInsertion = canInsert ? insX - 1 : -2;
    const deleted = canDelete && delX >= byInsertion;
    const from = deleted ? delX + 1 : insX;
    if (x > from) {
      backKinds.push(KEEP);
      backCounts.push(x - from);
    }
    backKinds.push(deleted ? DELETE : INSERT);
    backCounts.push(1);
    if (deleted) {
      x = delX;
      y = delX - k + 1;
    } else {
      x = insX;
      y = insX - k - 1;
    }
    backBase -= pd;
    if (backBase < 0) backBase = 0;
  }
  if (x > 0) {
    backKinds.push(KEEP);
    backCounts.push(x);
  }

  let lastKind = -1;
  for (let i = backKinds.length - 1; i >= 0; i--) {
    const kind = backKinds[i];
    const count = backCounts[i];
    if (lastKind === kind) counts[counts.length - 1] += count;
    else {
      kinds.push(kind);
      counts.push(count);
      lastKind = kind;
    }
  }
  return { kinds, counts };
}
/** 行数之和不超过 65 532（行 id 与位置都放得进 16 位）时用 16 位数组，更长才落到 32 位。 */
function editRuns(idsA, idsB) {
  return idsA.length + idsB.length <= 65532 ? editRuns16(idsA, idsB) : editRuns32(idsA, idsB);
}

/** makefun-diff 1.0.0's patch of input.old into input.new. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const a = tokenize(input.old);
  const b = tokenize(input.new);
  const n = a.length;
  const m = b.length;

  // The common prefix, then the common suffix of what is left.
  let prefix = 0;
  const shortest = n < m ? n : m;
  while (prefix < shortest && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && a[n - 1 - suffix] === b[m - 1 - suffix]) suffix++;

  const ids = new Map();
  const runs = editRuns(intern(a, prefix, n - suffix, ids), intern(b, prefix, m - suffix, ids));
  const kinds = runs.kinds;
  const counts = runs.counts;
  const middle = kinds.length;

  // The change runs: each a stretch of deletions and insertions between two kept lines, at old line o and new line p.
  const runTotal = middle + (prefix > 0 ? 1 : 0) + (suffix > 0 ? 1 : 0);
  const runKind = new Int8Array(runTotal);
  const runCount = new Int32Array(runTotal);
  let runAt = 0;
  if (prefix > 0) {
    runKind[runAt] = KEEP;
    runCount[runAt] = prefix;
    runAt++;
  }
  for (let i = 0; i < middle; i++) {
    runKind[runAt] = kinds[i];
    runCount[runAt] = counts[i];
    runAt++;
  }
  if (suffix > 0) {
    runKind[runAt] = KEEP;
    runCount[runAt] = suffix;
  }

  const changeO = [];
  const changeP = [];
  const changeDels = [];
  const changeIns = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (let i = 0; i < runTotal; i++) {
    const kind = runKind[i];
    const count = runCount[i];
    if (kind === KEEP) {
      o += count;
      p += count;
      continue;
    }
    let at = changeO.length - 1;
    if (at < 0 || changeO[at] + changeDels[at] !== o || changeP[at] + changeIns[at] !== p) {
      changeO.push(o);
      changeP.push(p);
      changeDels.push(0);
      changeIns.push(0);
      at++;
    }
    if (kind === DELETE) {
      changeDels[at] += count;
      o += count;
      deleted += count;
    } else {
      changeIns[at] += count;
      p += count;
      inserted += count;
    }
  }

  // The hunks: change runs at most 2 * CONTEXT kept lines apart share one.
  const hunkOf = new Int32Array(changeO.length);
  let hunks = 0;
  for (let i = 0; i < changeO.length; i++) {
    if (hunks > 0) {
      const prev = i - 1;
      if (changeO[i] - (changeO[prev] + changeDels[prev]) <= 2 * CONTEXT) {
        hunkOf[i] = hunks - 1;
        continue;
      }
    }
    hunkOf[i] = hunks;
    hunks++;
  }

  const out = [`${FORMAT} old=${n} new=${m} hunks=${hunks} deleted=${deleted} inserted=${inserted}\n`];
  let i = 0;
  while (i < changeO.length) {
    const first = i;
    let last = i;
    while (last + 1 < changeO.length && hunkOf[last + 1] === hunkOf[first]) last++;
    const oldStart = Math.max(0, changeO[first] - CONTEXT);
    const newStart = changeP[first] - (changeO[first] - oldStart);
    const after = Math.min(CONTEXT, n - (changeO[last] + changeDels[last]));
    const oldEnd = changeO[last] + changeDels[last] + after;
    const newEnd = changeP[last] + changeIns[last] + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (let c = first; c <= last; c++) {
      const co = changeO[c];
      const cp = changeP[c];
      for (; at < co; at++) writeLine(out, KEEP_OP, a[at]);
      const dels = changeDels[c];
      for (let j = 0; j < dels; j++) writeLine(out, DELETE_OP, a[co + j]);
      const ins = changeIns[c];
      for (let j = 0; j < ins; j++) writeLine(out, INSERT_OP, b[cp + j]);
      at = co + dels;
    }
    for (; at < oldEnd; at++) writeLine(out, KEEP_OP, a[at]);
    i = last + 1;
  }
  return out.join('');
}

/** A line as the patch writes it: its op, the line, and "%" on a line of its own when the line has no newline. */
function writeLine(out, op, line) {
  const end = line.charCodeAt(line.length - 1);
  out.push(end === 10 ? op + line : op + line + '\n%\n');
}
