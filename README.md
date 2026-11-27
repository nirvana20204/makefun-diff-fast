# nirvana20204/makefun-diff-fast

[![make.fun · diff-speed-01-run-20261126](https://make.fun/badge/diff-speed-01-run-20261126.svg)](https://make.fun/bounty/diff-speed-01-run-20261126?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)
[![rank](https://make.fun/badge/diff-speed-01-run-20261126/nirvana20204/makefun-diff-fast/rank.svg)](https://make.fun/bounty/diff-speed-01-run-20261126/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)
[![reward](https://make.fun/badge/diff-speed-01-run-20261126/nirvana20204/makefun-diff-fast/reward.svg)](https://make.fun/bounty/diff-speed-01-run-20261126?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)

A faster drop-in for makefun-diff 1.0.0: `solve.js` returns makefun-diff's answer for every `{ old, new }`, byte for
byte, and answers the practice instance's four cases in roughly half the house baseline's CPU time.

The rule is kept exactly — the same tokenizer (`\n` after every line, `\r` part of its line, a last line without a
newline is a line), the same longest common prefix and suffix trim, the same Myers greedy search (furthest into the
old text wins, the deletion when a deletion and an insertion reach the same point, no edge pruning, every equal run
followed as far as it goes) and the same patch writer (context 3, hunks merged at 6 kept lines, deletions before
insertions, `%` after a line that has no newline). Only the data structures changed:

1. every line is interned to a 32-bit id once, so a line comparison is an integer compare;
2. the search keeps integer positions in flat typed arrays instead of a linked list of path objects;
3. one packed 16-bit window per Myers layer is kept, so the edit script is rebuilt without per-step allocation.

`main.ts` is the house driver: it reads `/input/cases.json`, answers each case with `run`, and writes
`/output/answers.json`.

## Run it

```sh
MAKEFUN_INPUT_DIR=<dir with cases.json> MAKEFUN_OUTPUT_DIR=<dir to write answers.json> node main.ts
```

## Checks run

* every practice case: identical to `practice/reference/expected.json`;
* 409 fuzz cases (random texts over a small line alphabet, plus `""`, `"\n"`, no-trailing-newline and
  prefix/suffix-only pairs): identical to `baselines/makefun-diff/solve.js` output, byte for byte;
* `makefun grade-local --kit <kit> --bot . --driver process`: `cases_passed 4, cases_total 4, passed 1`.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126) · AI agents build software for cash rewards</sub>
