# 10 — Harness: short windows and layout-sensitive rows

**Status:** open · **Kind:** tooling · **Risk:** low

Four "regressions" chased this session were measurement artefacts. Each cost a
bisect + profile before it was recognised. Fixing the harness is cheaper.

## A. Windows that measure JIT tier-up, not steady state

- Fixed already: `decoder/churn`, `decoder/map-churn`, `callbacks/map-churn`,
  `callbacks/add-remove-churn` warmed up for 50 frames of 20–45 µs each; the
  decode path needs ~1 500 frames to reach the optimizing tier. A build that was
  6–11 % faster at steady state read +12…+20 % slower — twice. They now use
  `warmup: 2000` (A/A −1.6 %, n.s.); their absolute numbers are ~40 % lower than
  in older sections of `bench/v6-results.md`.
- **Still short:** `encoder/construct` (`warmup: 2`, 5 iterations × 7 reps = 35
  measured runs of 5 000 entities). It read +4…+6 % for a change that is at
  parity in a plain 60-run loop and +2.7 % (n.s.) with `--iters 40`.
- To do: audit every scenario for `warmup × frame time`; anything under ~50 ms
  of warm-up on a µs-scale op is suspect. Consider a harness-level minimum
  warm-up *time* instead of a run count.

## B. Rows that move with memory layout, not code

`mutations/map-ops/has-str` (a 13 ns native string-keyed `Map.has`) read
+8.9 %, then −4 %, then +14 % across builds in which `MapSchema.has` is
byte-identical (`return this.$items.has(key)`), each time with a tight A/A.
`mutations/map-ops/forEach-num` behaves the same way (−1.4 %, +3.9 %, +9.5 %,
+5 %). The last swing appeared at a step that changed only
`assertInstanceType` and `Root.remove`, neither of which runs in the loop: where
the setup happens to place the table and the key strings decides the row.

- To do: for such rows, randomise the layout per sample (allocate a random
  amount of padding before building the fixture) so the effect averages out
  instead of being frozen per build; or report them separately as
  "layout-sensitive".

## C. Conveniences that would have saved time

- `run.mjs --filter` takes ONE pattern (the last wins). Accept a comma list.
- `--compare` cannot override a scenario's `warmup`; add `--warmup`.
- A `--bisect base b1 b2 …` mode: the manual loop
  `for b in …; do run.mjs --compare base $b --filter row; done` localised every
  real regression in one run.
- Print the A/A noise floor next to a flagged row automatically (re-run the
  flagged unit as `--compare A A`).
- The full sweep takes ~46 min and must run detached with the machine quiet;
  the harness could skip units whose inputs (the two bundles' relevant
  functions) are byte-identical — most of a late-round sweep.
