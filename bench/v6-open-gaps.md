# Where v6 still loses to v5 — handoff after round 2

State of play (2026-09-15, end of round 2; see `bench/realworld-results.md`
for everything v6 wins and how each round-2 fix was found): the merged v6
working tree, frozen as `bench/.builds/M4-ABCD`, measured against a fresh
`master` 5.0.31 build (`bench/.builds/v5-release`) on the real-world matrix
at N = 20 per side, and against the round-2 start (`bench/.builds/x10-noshrink`,
what the round-2 subsections call `base`) on the whole existing matrix at
N = 12 — ABBA, one process per sample, Mann-Whitney U. Raw rows:
`bench/results/E-rw-<scenario>.json`, `bench/results/E-mx-<group>.json`,
`bench/results/E-recheck-bootstrap-n30.json`; log `%TEMP%\agentE-sweep.log`.
Everything not listed here is faster than v5 (the real-world rows by
6–94 %, `bench/realworld-results.md` "Round 2 — final").

Builds:

| label | what |
|---|---|
| `bench/.builds/v5-release` | `master` 5.0.31 (`cf0ff9b`) |
| `bench/.builds/x10-noshrink` | end of round 1 = start of round 2 (`base` in the round-2 subsections) |
| `bench/.builds/M4-ABCD` | round-2 final: `x10-noshrink` + the accepted A1, B1–B2, C1–C3, D1 + D2b patches |

Reproduce any row:

```bash
node bench/run.mjs --compare bench/.builds/v5-release bench/.builds/M4-ABCD --samples 20 --filter "<unit>"
node bench/run.mjs --compare bench/.builds/x10-noshrink bench/.builds/M4-ABCD --samples 20 --filter "<unit>"
node bench/profile.mjs --cpu <unit> --interval 100 --build bench/.builds/M4-ABCD   # or --build bench/.builds/v5-release
node bench/profile-v8.mjs --deopt|--ic|--inlining <unit>
npm run bench:gate     # budgets, incl. the three real-world units below
```

The builds are machine-local (`bench/.builds/` is gitignored); rebuild them
with `npm run bench:snapshot <label>` (v6) and, for v5, a worktree of
`master` built and copied as described in `bench/realworld-results.md`.

## 1. ArraySchema `shift` / `indexOf` / `forEach` — the storage model

Round 2 (agent C) took the overrides in `src/types/custom/ArraySchema.ts` as
far as a JS loop goes: search loops per element kind, unrolled ×8 for refs
(C1, C3), callback builtins without `Function#call` (C2). What is left is
the `ArraySchema extends Array` model itself. "Δ vs v5 (C3)" is agent C's
direct A/B (N = 20, `bench/results/Cfinal-vs-v5-*.json`); the `x10` →
`M4-ABCD` columns are this sweep (N = 12) — `M4-ABCD` is within 1 % of
`C3-unroll8` on every row, so the v5 Δ carries over.

Server side (`mutations/*`, encoder-side instance behind the `set`-only Proxy):

| unit | v5 | `x10-noshrink` | `M4-ABCD` | Δ x10 → M4 (p) | Δ vs v5 (C3) | round-2 start |
|---|---|---|---|---|---|---|
| mutations/array-iterate/shift-push (2000 refs) | 5.18 µs | 11.16 µs | 11.23 µs | +0.6 % (.44) | **+117 %** | +116 % |
| mutations/array-refs/push-shift-2000 (Schema children, encoded each tick) | 6.09 µs | 12.06 µs | 11.76 µs | −2.5 % (< .001) | **+102 %** | +123 % |
| mutations/array-iterate/indexOf-last (2000 refs) | 0.831 µs | 2.213 µs | 1.597 µs | −27.8 % (< .001) | **+94 %** | +165 % |
| mutations/array-iterate/forEach | 4.20 µs | 5.91 µs | 5.42 µs | −8.2 % (< .001) | +28 % | +39 % |
| mutations/array-iterate/filter | 5.98 µs | 6.99 µs | 6.62 µs | −5.2 % (< .001) | +13 % | +20 % |
| mutations/array-iterate/map | 5.66 µs | 5.81 µs | 5.43 µs | −6.4 % (< .001) | −4 % | +5 % |
| mutations/array-refs/push-shift-100 | 3.00 µs | 3.06 µs | 2.86 µs | −6.3 % (< .001) | +2.7 % (C3; ≈ −5 % at M4, cross-sweep) | +2.5 % |
| stateview/array-reindex/shift-100 (`@view` ring buffer) | 10.9 µs | 11.05 µs | 10.80 µs | −2.3 % (.003) | +2 % (C3; ≈ −1 % at M4, cross-sweep) | +4 % |

Client side (`decoder/array-read/*`, plain `Array` subclass, no Proxy):

| unit | v5 | `x10-noshrink` | `M4-ABCD` | Δ x10 → M4 (p) | Δ vs v5 (C3) | round-2 start |
|---|---|---|---|---|---|---|
| decoder/array-read/indexOf-last | 0.826 µs | 1.993 µs | 1.590 µs | −20.2 % (< .001) | **+93 %** | +137 % |
| decoder/array-read/filter | 6.24 µs | 7.57 µs | 7.13 µs | −5.8 % (< .001) | +15 % | +22 % |
| decoder/array-read/forEach | 4.93 µs | 5.84 µs | 5.50 µs | −5.8 % (< .001) | +13 % | +20 % |
| decoder/array-read/map | 6.05 µs | 6.42 µs | 6.08 µs | −5.2 % (< .001) | +0.7 % | +7 % |

(`index` −98 %, `length+at` −96 %, `for-of` −38 %, `spread` −8 % vs v5 are
wins and did not move; `mutations/array-refs` push-pop / splice-head /
unshift-pop are −2 … −36 % vs v5 and another −4 % in round 2.)

Why the rest is the storage model, not the overrides:

- **`shift` on thousands of refs (+117 % / +102 %)**: the slide loop
  (`arrRemove`, inlined into `shift`) has no deopt and no polymorphic IC and
  runs at ~1 ns per element when the process is quiet (2.2 µs for 2000). In
  the scenario every op appends a fresh child, so the moved pointers are
  young and the backing store is old: every one of the 1999 stores takes
  V8's `RecordWrite` slow path (remembered-set insert) — 11 µs once the
  process allocates ~1 KB per op. v5's internal array moves the elements in
  C++ (`Heap::MoveRange`, one range barrier). Rebuilding the backing store
  young (`length = 0` + regrow) was measured and rejected (14.7 µs); the
  native mutators on a subclass receiver take the generic path (67–79 µs).
- **`indexOf` (+94 %)**: 0.8 ns per element for the unrolled JS loop (bounds
  check + load + compare) against 0.4 ns for the native C++ loop on a plain
  array; the native builtin on the subclass receiver is 3× slower than the
  loop (`lastIndexOf` 60×). On the encoder side the scenario also pays three
  Proxy [[Get]]s (~0.2–0.3 µs).
- **`forEach` / `filter` (+13 … +28 %)**: v5 hands the plain internal array to
  the native builtin, which TurboFan inlines together with the callback;
  the subclass loop keeps a keyed load with map and bounds check per
  element (~0.5 ns each). `map` is at parity.

**Storage-model question (for the user, not decided here).** Only a native
element move recovers the `shift` rows, i.e. plain-array storage on the
encoder side or a ring/head offset inside the subclass (every index read
would pay the offset). The 6.0 internal-array build
(`SCHEMA_ARRAY_IMPL=internal`, `bench/array-impl-comparison.md`) had
`push-shift-2000` at 2.9 µs (−51 % vs v5) and `indexOf-last` at 0.72 µs, at
the price of 2× slower `arr[i]` on the encoder side, 54× on the decoder
side, +44 % on `decoder/tick` and +32–40 % on callbacks. Keeping the
`Array` subclass keeps every read path and `index` / `for-of` / `length+at`
as they are and leaves `shift`-heavy queues of thousands of children
+100 % vs v5; the guidance stands: trim such queues in `splice` batches or
key them in a `MapSchema` by sequence number.

## 2. `decoder/churn` — +5 % vs the round-2 start

| unit | `x10-noshrink` | `M4-ABCD` | Δ | p | N |
|---|---|---|---|---|---|
| decoder/churn/default (merge verification) | 44.2 µs | 46.4 µs | **+5.1 %** | .016 | 30 |
| decoder/churn/default (this sweep) | 40.7 µs | 42.0 µs | +3.0 % | .157 | 12 |
| agent D's own sweeps (`base` → `D2b-expando`) | 40.7 µs | 42.1 µs | +3.3 % / +3.6 % | .019 | 20 |

Consistently +3 … +5 % across four runs, once significant at N = 30; GC time
per sample is *lower* on `M4-ABCD` (3.4 → 2.2 ms). Isolation builds at N = 30
(`bench/realworld-results.md`, "Merge verification"): reverting D's
`utf8Read` tiers gives −0.2 % (p .78) and costs `lobby-chat/dec` +6.5 %;
reverting the `decodeInfo` expando gives −2.5 % (p .28) and
`memory-footprint` +1.0 %. Neither component explains the row alone; the
unit's median moved between 42.3 and 46.4 µs across runs. Next step, if it
is pursued: a `--cpu --interval 100` profile pair (`x10-noshrink` vs
`M4-ABCD`) of this unit, looking at the ADD path of `Player` refs (the
churn frames add and delete 10 % of 1000 players per frame) rather than the
string readers (2.5 % of self time). Every other decoder row is within
±2 % or better: `bootstrap` read +2.1 % at p .019 at N = 12 and **+0.7 %,
p .038 at N = 30** (`E-recheck-bootstrap-n30.json`), `tick` +1.0 % (p .84),
`resync` +0.5 / +0.7 % (n.s.), `map-bootstrap/players-str-1000` +12.8 % at
p .069 (bimodal unit, n.s.).

## 3. Retained memory per entity — not a gap (kept for the record)

| | v5 | `x10-noshrink` | `M4-ABCD` |
|---|---|---|---|
| `encoder/memory-footprint` (1000 bloat players + encoder, `heapUsed` delta) | 2 473 KB | 2 616 KB | 2 614 KB (−0.1 % vs x10, p .039; +4.7 % vs v5 at **p .35**, agent D) |
| slope, KB per player (2000 / 4000 players) | **2.37** | 2.34 | **2.31** |

The per-entity cost is 1–2 % below v5's; the +140 KB is a fixed
per-process intercept (v6 ≈ 275 KB vs v5 ≈ 80 KB: more library code compiled
and per-class caches built on first construction) and the reading is
bimodal by ~170 KB on the same build. If the intercept matters (many small
isolates) the candidates are the per-class caches (`EncodeDescriptor`,
`DecodeInfo`, generated accessors) — not measured separately.

## 4. Closed in round 2

"before" = v5 vs `x10-noshrink` (round-1 end, `bench/realworld-results.md`
§4b and the previous revision of this file); "after" = v5 vs `M4-ABCD`
(this sweep, N = 20) unless marked.

| gap | before (v5 vs `x10-noshrink`) | after (v5 vs `M4-ABCD`) | what fixed it |
|---|---|---|---|
| realworld/small-patch/root-field | 0.208 → 0.303 µs, **+45 … +49 %** | 0.195 → 0.192 µs, −1.8 % (p .16) | A1: `releaseFrames` keeps high-water marks instead of `length = 0` on two scratch arrays (`src/encoder/EncodeOperation.ts`) |
| realworld/small-patch/one-entity | **+20 … +25 %** | 0.274 → 0.240 µs, **−12.3 %** | A1 |
| realworld/small-patch/five-entities | −5 % | **−17.0 %** | A1 |
| realworld/turn-based/enc | **+10 … +12 %** | 0.918 → 0.866 µs, **−5.7 %** (p .001) | A1 |
| realworld/small-patch/idle-50views | +3 % (p .047) | +1.1 % (p .54) | nothing (A/A floor of the unit) |
| stateview/tags | 29.8 → 34.7 µs, **+20 %** | 34.6 → 18.2 µs vs x10 (**−47.5 %**); **−35 %** vs v5 (agent B, N = 20) | B1: chunk cache keyed per (tree, tag key) within a tick; B2: `tree.tagViews` as parallel arrays, `tagsOnTree` / `tagKey` (`src/encoder/StateView.ts`, `Encoder._emitViewTrees`) |
| encoder/string-heavy | 21.4 → 22.2 µs, **+4 %** | 22.5 → 17.1 µs vs x10 (**−24.3 %**); **−21 %** vs v5 (agent D, N = 20); bytes 3 929 → 3 605 | D1: single-pass `writeString` with back-patched length, `encodeInto` from 32 chars, tiered `utf8Read` (`src/encoding/varint.ts`, `decode.ts`) |
| encoder/memory-footprint | +6 % (p .19) | 2 614 KB, +4.7 % vs v5 (p .35); slope −2.5 % | D2b: `decodeInfo` off `ChangeTree` (lazy expando on the tracked root); measured to be a fixed intercept, not per entity (§3) |
| array `indexOf-last` (mutations / decoder) | **+165 % / +137 %** | **+94 % / +93 %** (x10 → M4 −27.8 % / −20.2 %) | C1 + C3: search loops per element kind, refs unrolled ×8 (`src/types/custom/ArraySchema.ts`) |
| array `forEach` / `filter` / `map` (mutations) | +39 % / +20 % / +5 % | +28 % / +13 % / −4 % (x10 → M4 −8.2 % / −5.2 % / −6.4 %) | C2: callback builtins without `Function#call` |
| array `forEach` / `filter` / `map` (decoder) | +20 % / +22 % / +7 % | +13 % / +15 % / +0.7 % | C2 |
| mutations/array-refs push-shift-100 / splice-head-500 / unshift-pop-500 | +2.5 % / −36 % / −11 % | x10 → M4 −6.3 % / −4.0 % / −3.9 % | C1–C3 (the `shift` slide itself did not move, §1) |

Side effects worth knowing (x10 → M4, N = 12): `big-state/encode-10k` −8.5 %
and `encoder/encode-all` −9.3 % (D1 + A1), `map-encode-all` −3.5 … −15.8 %,
`steady-tick/mut10` −9.9 %, `stateview/views` v1 / v50 −3.6 % / −6.6 %,
`view-churn` −5.1 %, `stateview/bootstrap` −4.3 %, `lobby-chat/callbacks`
−25 % vs v5 (was −13 %); no row regressed at p < .05 and |Δ| ≥ 2 % except
`decoder/churn` (§2).

## 5. Not measured / left open

- Other-language decoders (C#, Lua, Haxe, Java, Swift, …) must implement the
  two header changes of round 1 (refId delta, run flag + run body) —
  `SPEC.md` "Message and chunks" is the reference, `test/RunOps.test.ts` and
  `test/KeyedWire.test.ts` the byte-level fixtures.
- Runs never cover `@view`-tagged fields (the tags shape), fields past index
  31, or classes overriding `[$filter]`; the `_emitViewTrees` run peek
  evaluates `peek.encDescriptor` before `tree.isFiltered` (≤ 3 % of the tags
  tick, not measured).
- `root-field` is at parity, not ahead: the one-field patch is 7 B on v6
  against 5 B on v5 (header + length prefix); the only untried lever is a
  cached `buffer.subarray` at the end of `encode()` (API-visible identity
  change, not made).
- `hasPendingChange` (`src/decoder/strategy/Callbacks.ts`) is O(batch) per
  `listen()` inside `onAdd`; not seen in any profile, only run at 10k entities.
- The reader's 16–47-byte `utf8Read` tier is a JS loop; Node's
  `Buffer.prototype.utf8Slice` / `utf8Write` are 5–40 % faster above 32 bytes
  but Node-only (measured, not taken). The `encodeInto` path allocates a
  `subarray` per string ≥ 32 chars (`string-heavy` GC 1.96 → 4.15 ms per
  sample, wall-clock still −24 %).
- `big-state/decode-10k` GC per sample is higher on v6 (312 → 662 ms; a
  fresh `Decoder` builds 10k `UntrackedChangeTree` + entity pairs at once)
  while wall-clock halves; not profiled.
- **Budgets (done this round):** `realworld/small-patch/root-field` 0.4 µs/tick,
  `realworld/large-patch/enc-5k` 1.6 ms/tick, `realworld/entities-aoi/n2000-c50`
  2.0 ms/tick (≈ 2 × the `M4-ABCD` medians 0.192 µs / 0.781 ms / 0.987 ms);
  `gate: true` on those three scenario files puts all 17 of their variants in
  `npm run bench:gate`, budgets only on the three named units. The
  pre-existing gates (`encoder/steady-tick`, `decoder/tick`, `e2e/room-tick`,
  `stateview/views`, `callbacks/strategies`) keep their round-1 budgets and
  pass on this tree.
