# bench/ — consolidated performance suite

Benchmarks, profiling, and the optimization protocol for the encoder, decoder,
StateView, and callback subsystems. Everything runs against the **compiled
bundle** (`build/index.mjs` or a snapshot of it) in **isolated child
processes** — one process per sample, so JIT state never leaks between builds
or samples.

## Quick start

```bash
npm run build                 # scenarios import the compiled bundle
npm run bench                 # full matrix, 5 samples each, median±IQR table
npm run bench -- --filter encoder/*        # subset
npm run bench -- --filter gate --samples 3 # the release-gate subset
npm run profile:cpu -- decoder/tick        # CPU sampling profile + ranked report
npm run profile:heap -- decoder/tick      # allocation-site profile (--heap-prof)
```

## A/B comparison (the only accepted way to judge an optimization)

```bash
npm run bench:snapshot base          # build + freeze current tree as bench/.builds/base
# ...apply your candidate change...
npm run bench:snapshot candidate
npm run bench:compare -- bench/.builds/base bench/.builds/candidate --samples 20
```

Compare mode runs ABBA-interleaved samples (cancels thermal/load drift, one
discarded warm pair) and reports Mann-Whitney U p-values for **wall-clock and
GC time separately**, plus heap deltas and encoded byte counts (bytes must
match — a mismatch means the wire format changed).

**Methodology (non-negotiable, learned the hard way):**
- N ≥ 20 samples per side. N=5 cannot resolve sub-5% effects.
- Isolated process per sample; interleaved ABBA order.
- Accept iff target improves at p < 0.05 with |Δ| ≥ 2% — or for GC-pressure
  candidates, gcMs/heap improves at p < 0.05 with wall-clock non-regressing —
  AND no other scenario regresses > 2% at p < 0.05 (full-matrix sweep).
- An A/A null run (`--compare X X`) should show p > 0.05 on ≥95% of rows;
  re-certify when changing the harness or machine.

## Scenario contract

Scenario files live in `scenarios/<subsystem>/<name>.mjs`:

```js
export default {
  name: "encoder/steady-tick",
  unit: "ms/tick",
  variants: [{ name: "mut10", mutations: 10, iterations: 5000 }],
  iterations: 5000,          // per rep (variant.iterations overrides)
  reps: 7,                   // child reports median-of-reps
  warmup: 50,                // optional (default max(50, iterations/5))
  valueScale: 1,             // optional value multiplier (e.g. µs/entity)
  measure: "time",           // or "heap" → value = retained KB
  gate: true,                // include in `--filter gate`
  budget: { mut10: 0.01 },   // optional --assert ceiling, in `unit`
  setup(lib, variant, plan) { return ctx; },   // lib = imported build module
  run(ctx, i) { return encodedBytes; },        // ONE op; timed region
  teardown(ctx) {},          // optional invariant checks (throw = sample fails)
};
```

Rules:
- `setup` receives the library module — never import the library at top level
  (that's what makes two-build A/B possible).
- Pre-generate decode frames in `setup`, never in `run`.
- Frames with ADD/DELETE (churn) are **not replay-safe** (refId reuse): size
  the frame list to `plan.totalRuns` and consume each frame once.
- Fixtures (`lib/fixtures.mjs`) set `Encoder.BUFFER_SIZE = 4MB` — required
  before constructing any Encoder.
- Return encoded byte counts from `run` where possible; the compare table
  uses them as a wire-format regression guard.

## Canonical shapes (historical comparability)

- **Bloat** (`src/bench_bloat.ts` lineage): `State { players: Map<Player { name,
  position: Position{x,y}, scores: number[] }> }`, N=1000.
- **Deep** (`bench_encode.js` / `bench_view.js` lineage): `State → 50 Player →
  10 Item → 5 Attribute` with `@view()` tags on privateGold, secretInventory,
  cooldown, ownerSecret, secret, adminSecret.

## Optimization protocol

1. Intake a candidate from the profile reports (`results/PROFILE_*.md`).
2. **Cross-check `DEAD_ENDS.md`** — exact and adjacent mechanisms.
3. Write the hypothesis in `OPTIMIZATION_LOG.md` (target, expected metric, affected scenarios).
4. Implement; `npm test` must stay green.
5. Snapshot both sides; targeted compare at N≥20; full-matrix regression sweep.
6. Accept/revert per the criteria above; record the verdict with numbers.
   Failed candidates go to `DEAD_ENDS.md` so they are never retried.

## Directory map

- `run.mjs` — runner CLI (single / `--compare` / `--assert`)
- `profile.mjs` — CPU / allocation profiler driver (`lib/analyze-*.mjs` rankers)
- `snapshot-build.sh <label>` — freeze a build into `.builds/<label>/`
- `lib/` — child harness, stats (Mann-Whitney/HL), GC observer, fixtures, report
- `scenarios/{encoder,stateview,decoder,callbacks,e2e}/`
- `results/` — measurement outputs (JSON runs, profile reports); machine-specific, kept out of git along with `.builds/` and `profiles/`
