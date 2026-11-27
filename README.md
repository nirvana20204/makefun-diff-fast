# makefun-diff, faster: a drop-in for makefun-diff 1.0.0

`solve.js` returns makefun-diff 1.0.0's answer for `{ old, new }` — the same tokenizer, the same common
prefix/suffix trim, the same Myers greedy search (deletion-first tie-break, no edge pruning, equal runs followed
as far as they go) and the same patch writer — but it runs on three changes that do not touch the rule:

1. every line is interned to a 32-bit id once, so a line comparison is an integer compare;
2. the search keeps integer positions in flat typed arrays instead of a linked list of path objects;
3. one packed 16-bit window per Myers layer is kept, so the edit script is rebuilt without per-step allocation.

`main.ts` is the house driver: it reads `/input/cases.json`, answers each case with `run`, and writes
`/output/answers.json`.

## Checks run

* every practice case: identical to `practice/reference/expected.json`;
* 409 fuzz cases (random texts over a small line alphabet, plus `""`, `"\n"`, no-trailing-newline and
  prefix/suffix-only pairs): identical to `baselines/makefun-diff/solve.js` output, byte for byte.
