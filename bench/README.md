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

## Wire codec

The 6.0 wire format is the only codec (`lib.Encoder` / `lib.Decoder`);
`withCodecs()` / `codecOf()` in `lib/fixtures.mjs` are the scenario-facing
seam left from the v5/v6 comparison. `bench/v6-results.md` keeps the
measurements that motivated the format (v5 vs the v6 proof of concept on the
5.0.23 collections) and the A/B of the 6.0 collections rewrite against both.

Comparing against a 5.0.x snapshot build that ships both codecs: scenarios
construct `lib.Encoder` directly, so `--compare <snapshot>/build` measures
v5 except in the scenarios that go through `codecOf()` (which prefers
`Encoder6`). For a consistent baseline point `--compare` at a one-file shim
next to that build, e.g. `build-poc/index.mjs`:

```js
export * from "../build/index.mjs";
export { Encoder6 as Encoder, Decoder6 as Decoder, Reflection6 as Reflection } from "../build/index.mjs";
```

(or `export const Encoder6 = undefined, Decoder6 = undefined, Reflection6 = undefined;`
to force v5 everywhere).

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
2. State the hypothesis up front: target, expected metric, affected scenarios.
3. Implement; `npm test` must stay green.
4. Snapshot both sides; targeted compare at N≥20; full-matrix regression sweep.
5. Accept/revert per the criteria above; record the verdict with numbers.

## Directory map

- `run.mjs` — runner CLI (single / `--compare` / `--assert`)
- `profile.mjs` — CPU / allocation profiler driver (`lib/analyze-*.mjs` rankers)
- `snapshot-build.sh <label>` — freeze a build into `.builds/<label>/`
- `lib/` — child harness, stats (Mann-Whitney/HL), GC observer, fixtures, report
- `scenarios/{encoder,stateview,decoder,callbacks,e2e}/`
- `results/` — measurement outputs (JSON runs, profile reports); machine-specific, kept out of git along with `.builds/` and `profiles/`

## MapSchema scenarios

`lib/fixtures.mjs` `defineMapState(lib, keyType)` builds `State { players:
Map<Player{name, position}>, scores: Map<number> }` keyed by 8-char strings
or by integers (`key: "number"`; a build without typed keys ignores the
option and stringifies, so every scenario runs unchanged on a 5.x snapshot —
the number-key rows differ in bytes by design). Scenarios:
`encoder/map-churn` (delete 10 / re-add 10 per cycle, 100 and 1000 entries),
`encoder/map-replace` (10 % / 100 % of 1000 primitive entries per tick),
`encoder/map-encode-all` and `decoder/map-bootstrap` (1000 players / 10000
scores snapshots), `decoder/map-churn`, `decoder/map-replace`,
`callbacks/map-churn`, and `mutations/map-ops` (API cost, no wire). The
6.0 keyed-op fold and typed keys were measured with them against v5 and
the pre-change 6.0 build (`bench/v6-results.md`, "MapSchema rewrite").

## ArraySchema storage model

`bench/array-impl-comparison.md` compares v5, the 6.0 `Array` subclass and
a 6.0 build with the 5.x internal-array storage (the `ArraySchemaInternal.ts`
experiment, since removed; it lives in git history at `16ff6be`) across the
whole matrix plus `mutations/array-iterate` (encoder-side walks) and
`decoder/array-read` (client-side walks), with a usage survey of what user
code does with arrays.

## Real-world scenarios (`scenarios/realworld/`)

`lib/realworld.mjs` builds the shapes a Colyseus room actually has and drives
them with the server's own per-tick sequence (`serverTick` mirrors
`SchemaSerializer.applyPatches`: byte 0 is the protocol code, no state change
means only views with pending `add()`/`remove()` get a frame, otherwise one
shared `encode` and one `encodeView` per client into the same buffer, then
`discardChanges`). Every shape runs unchanged against a 5.0.x build.

- `entities-aoi` / `entities-aoi-large` — N moving entities (`x, y, vx, vy,
  rotation, hp, kind, name`) in a `@view()` map, C stationary clients each
  seeing the 3×3 cells around them (~9 % of a 3000×3000 world, cell 300);
  cell crossings turn into `view.add/remove`. Variants: plain `number`,
  `typed` (float32/int16), `nested` (`position: Vec2`), `numkeys` (6.0 typed
  map keys); 500/10, 2000/50 and 10000/200 entities/clients.
- `entities-aoi-decode` — one client's frames of that room, decoded once each.
- `big-state` — 10k / 20k entities + 100 players + 2000 tiles: `encodeAll`,
  a fresh `Decoder` per snapshot (with and without `onAdd → listen`), handshake.
- `large-patch` — 100 % of 5000 entities change `x, y, vx, vy` per tick
  (`number` / `typed` / `nested` / `quantized`), encode and decode.
- `small-patch` — the fixed cost when almost nothing changed among 5000
  entities: one root field, 1 or 5 entities, the same with 50 idle views, an
  idle tick.
- `lobby-chat`, `inventory-rpg`, `turn-based`, `mmo-shards` — chat ring
  buffer + presence, nested inventories with ref replacement, tiny state
  broadcast to 100/1000 clients, owner-only (`@view()`) and party (`@view(1)`)
  fields with 100/500 connected clients.

Results and the optimization round they drove: `bench/realworld-results.md`;
the rows where v6 still trails v5, with causes and next experiments:
`bench/v6-open-gaps.md`.
A/B rows against a 5.x build show `A:≠B !!` in the bytes column by design
(different wire formats); the byte guard is meaningful for 6.0-vs-6.0 only.
Do not edit `lib/*.mjs` or a scenario while a sweep runs: each unit's child
processes import them fresh.

## V8-level profiling (`profile-v8.mjs`)

`profile.mjs --cpu|--heap` samples; `profile-v8.mjs` asks V8 directly, on a
single unit with one rep:

```bash
npm run profile:deopt -- realworld/large-patch/enc-5k          # --trace-deopt-verbose: deopts per function + source position, LOOP flags
npm run profile:ic -- realworld/large-patch/enc-5k --iters 60  # --log-ic: inline-cache sites that went polymorphic/megamorphic (N/P/G), keyed by function:line:col
npm run profile:inlining -- realworld/large-patch/enc-5k --fn encodeQueue   # --trace-turbo-inlining: what got inlined into a function, what was refused
npm run profile:shapes                                          # --allow-natives-syntax: %HasDictionaryElements / %HaveSameMap over live encoder + decoder objects
npm run profile:cpu -- <unit> --interval 100                    # 100 µs sampling for µs-scale units
```

Raw logs land in `profiles/`; the `--ic` log grows by ~100 MB/s, so keep
`--iters` small (transitions happen during warm-up). Caveats printed with the
IC report: optimized code with inlined monomorphic handlers logs nothing, a
site that reached megamorphic stays silent afterwards, and call-site
polymorphism is not an IC event (use `--inlining` for calls). `profile.mjs`
suffixes the profile name with the build directory when `--build` is given,
so A/B profiles do not overwrite each other. `lib/wire-whatif.mjs
<unit> [--delta]` captures a unit's frames, parses the chunk stream and
projects the byte effect of format proposals before any is implemented.
