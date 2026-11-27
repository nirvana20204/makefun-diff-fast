// A faster drop-in for makefun-diff 1.0.0 (make.fun's line diff + patch), written from its documented rule:
// the same tokenizer, the same common prefix/suffix trim, the same Myers greedy search with the deletion-first
// tie-break, and the same patch writer. Everything the rule fixes is kept; only the data structures change:
//   1. lines are interned to 32-bit ids once, so a line comparison is an integer compare;
//   2. the search keeps integer positions in one flat Int32Array instead of a linked list of path objects;
//   3. one packed window per Myers layer is kept, so the edit script is rebuilt without allocating per step.

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
 * The runs of the edit script of the id sequences a and b, in order: kind[i] is KEEP, DELETE or INSERT and
 * count[i] how many lines it covers. The script is makefun-diff's: each layer d of Myers's greedy search keeps on
 * diagonal k the furthest old position reached, follows equal lines as far as they go, and takes the deletion when
 * a deletion and an insertion reach the same point.
 */
function editRuns(a, b) {
  const n = a.length;
  const m = b.length;
  const kinds = [];
  const counts = [];
  const push = (kind, count) => {
    const lastIndex = kinds.length - 1;
    if (lastIndex >= 0 && kinds[lastIndex] === kind) counts[lastIndex] += count;
    else {
      kinds.push(kind);
      counts.push(count);
    }
  };
  if (n === 0 && m === 0) return { kinds, counts };

  const max = n + m;
  const off = max + 1;
  // 位置 <= 65534 时用 16 位，省一半内存流量（-1 作为"无路径"的哨兵）。
  const Wide = max > 65533;
  const v = Wide ? new Int32Array(2 * max + 3).fill(-1) : new Uint16Array(2 * max + 3).fill(65535);
  const NONE = Wide ? -1 : 65535;
  const read = (i) => (Wide ? v[i] : v[i] === 65535 ? -1 : v[i]);
  const write = (i, x) => {
    v[i] = Wide ? x : x < 0 ? 65535 : x;
  };
  write(off + 1, 0);

  // 轨迹：第 d 层只有 k = -d, -d+2, ..., d，打包在 [base(d) + (k + d) / 2]，base(d) = d (d + 1) / 2。
  let trace = Wide ? new Int32Array(1 << 16) : new Uint16Array(1 << 16);
  const TraceNone = NONE;
  const tset = (slot, x) => {
    trace[slot] = Wide ? x : x < 0 ? 65535 : x;
  };
  const tget = (slot) => {
    const x = trace[slot];
    return Wide ? x : x === 65535 ? -1 : x;
  };

  let found = -1;
  let baseD = 0;
  for (let d = 0; d <= max && found < 0; d++) {
    const need = baseD + d + 1;
    if (need > trace.length) {
      let grown = trace.length * 2;
      while (grown < need) grown *= 2;
      const next = Wide ? new Int32Array(grown) : new Uint16Array(grown);
      next.set(trace);
      trace = next;
    }
    const half = d + 1;
    if (d === 0) {
      let x = 0;
      while (x < n && x < m && a[x] === b[x]) x++;
      write(off, x);
      tset(baseD, x);
      if (x >= n && x >= m) found = 0;
      baseD += half;
      continue;
    }
    for (let k = -d; k <= d; k += 2) {
      const slot = baseD + ((k + d) >> 1);
      let x;
      if (k === -d) {
        // 只有插入：来自上一层对角线 k+1
        const insX = read(off + k + 1);
        if (insX < 0 || insX - 1 - k >= m) {
          write(off + k, NONE);
          tset(slot, -1);
          continue;
        }
        x = insX;
      } else if (k === d) {
        // 只有删除：来自上一层对角线 k-1
        const delX = read(off + k - 1);
        if (delX < 0 || delX >= n) {
          write(off + k, NONE);
          tset(slot, -1);
          continue;
        }
        x = delX + 1;
      } else {
        const delX = read(off + k - 1);
        const insX = read(off + k + 1);
        const canDelete = delX >= 0 && delX < n;
        const canInsert = insX >= 0 && insX - 1 - k < m;
        if (!canDelete && !canInsert) {
          write(off + k, NONE);
          tset(slot, -1);
          continue;
        }
        if (canDelete) x = canInsert && insX - 1 > delX ? insX : delX + 1;
        else x = insX;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      write(off + k, x);
      tset(slot, x);
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
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
    const at = (kk) => (kk < -pd || kk > pd ? -1 : tget(backBase + ((kk + pd) >> 1)));
    const delX = at(k - 1);
    const insX = at(k + 1);
    const canDelete = delX >= 0 && delX < n;
    const canInsert = insX >= 0 && insX - 1 - k < m;
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
    backBase -= d - 1;
    if (backBase < 0) backBase = 0;
  }
  if (x > 0) {
    backKinds.push(KEEP);
    backCounts.push(x);
  }
  for (let i = backKinds.length - 1; i >= 0; i--) push(backKinds[i], backCounts[i]);
  return { kinds, counts };
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
