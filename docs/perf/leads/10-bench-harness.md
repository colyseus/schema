# 10 — Harness: short windows and layout-sensitive rows

**Status:** closed (B partially: layout rows are randomised + labelled, not made tight) · **Kind:** tooling · **Risk:** low

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

## Outcome (2026-09-22)

All in `bench/` (`run.mjs`, `lib/child.mjs`, `lib/stats.mjs`, two scenarios);
`src/` untouched, 1081 passing / 1 pending.

- **A. Minimum warm-up time.** Audit (one sample per unit, `R8-A`): 141 of
  144 units warmed up for < 100 ms at their scenario counts (the four churn
  rows fixed earlier: 36–93 ms; `small-patch`, `array-read`, `map-ops`:
  2–10 ms). `run.mjs` now calibrates from the discarded warm pair (single
  mode: the first sample): a unit under `--min-warmup-ms` (default 100)
  gets `ceil(100 ms / steady ms-per-run)` warm-up runs on both sides, passed
  as `child.mjs --warmup=N` so `plan.totalRuns` frame lists stay right.
  `--min-warmup-ms 0` restores the old behaviour. `forEach-num` `R6-E → R8-A`:
  +7.3 % / +6.4 % (p < .001) before, +1.8 % / +0.2 % with the floor alone.
- **`encoder/construct` was not a short window, it was a V8 lottery.**
  Allocation-site pretenuring kicks in for the entity sites in 10–50 % of
  processes whatever the warm-up (warm-up 2/8/20/40/80 runs: 0/6, 4/6, 1/6,
  5/10, 1/10 slow), and GC per sample jumps 60 → 160 ms (2.4 → 3.2 µs/entity).
  A longer warm-up made the A/A *worse* (Δ −7.5 / −23 / −1.6 %, IQR up to
  34 %). The scenario now runs with `nodeFlags: ["--no-allocation-site-pretenuring"]`
  and `warmup: 10`: A/A Δ +0.8 / +1.7 / −0.4 %, IQR 1–4 %, range 4–13 %
  (was 13–36 %). Pretenuring regressions are invisible in this row by design.
- **B. Layout rows.** `layoutSensitive: true` (the `map-ops` read variants)
  gets a seeded-random heap padding per sample pair and prints `(layout)`.
  `forEach-num` `R6-E → R8-A`: −2.1 % / +0.9 % (n.s.) with floor + padding.
  `has-str` is a per-process two-mode lottery (12.2 vs 14.1 µs/op, each
  process tight) that survives a fixed `--hash-seed` and a fixed pad seed;
  padding only reshuffles the mode mix. Old-harness A/A flagged it (+5.9 %,
  p = .007); new A/A +0.4 / +1.4 %. It still needs ≥ 20 samples and the A/A.
- **Two-mode detector** (`stats.bimodal`): rows whose samples split into two
  regimes print `(2 modes)` (bisect: `²`).
- **C.** `--filter a,b` (union; repeatable), `--warmup N` (all modes),
  automatic A/A re-run of flagged rows (column `A/A Δ% (p)`, `--no-aa`),
  `--bisect base b1 b2 …` (one row per unit, one Δ column per build),
  `--pad` / `--no-pad`, scenario `nodeFlags` / `minWarmupMs`. Skipping
  byte-identical units: not done.
- Cost: ≤ 100 ms more per sample, ≈ +4–5 min on the full sweep, plus the
  A/A re-runs of flagged rows.
