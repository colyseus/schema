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

## 0. Re-measured 2026-11-10 against 5.0.45

`bench/.builds/v5.0.45` vs the working tree (`gaps-base` before, `gaps-sort2`
after the `sort()` change below), N = 8. This supersedes the numbers in §1–§2:
`decoder/churn` (−79 %) and the `forEach` / `map` / `filter` rows (−6 … −35 %)
are wins now. What is still slower than 5.0.45:

| unit | 5.0.45 | v6 | Δ |
|---|---|---|---|
| mutations/array-iterate/indexOf-last (2000 refs) | 0.69 µs | 1.90 µs | **+176 %** |
| decoder/array-read/indexOf-last | 0.66 µs | 1.60 µs | **+142 %** |
| mutations/array-iterate/shift-push (2000 refs) | 5.69 µs | 7.96 µs | **+40 %** |
| mutations/array-refs/push-shift-2000 | 5.76 µs | 7.98 µs | **+39 %** |
| decoder/array-read/for-of | 7.34 µs | 8.44 µs | +15 % (p .07) |

**Closed: `sort()`** (not in the earlier revisions of this file). v6 shipped
the full permutation and built a `Map` of the whole array on every call;
`refs-500-swap` was +171 % and 885 B against 20 B. `sort()` / `move()` now
record a REORDER over the smallest range of slots that changed (wire:
`REORDER start, count, oldPos*count`, positions counted from `start`), a
REVERSE when the whole array flips, and nothing — without writing the array
— when the order is unchanged. Duplicate refs no longer drop the op.

| mutations/array-sort | 5.0.45 | before | after | Δ vs 5.0.45 | bytes 5.0.45 → before → after |
|---|---|---|---|---|---|
| refs-50-swap | 2.39 µs | 3.98 µs | 2.03 µs | −13 % | 13 → 60 → 13 |
| refs-50-still | 1.19 µs | 2.73 µs | 1.14 µs | −2 % (n.s.) | equal |
| refs-500-swap | 10.4 µs | 30.1 µs | 9.74 µs | −6 % | 20 → 885 → 15 |
| refs-500-flip | 50.0 µs | 31.5 µs | 10.2 µs | −80 % | 2740 → 877 → 3 |
| nums-500-swap | 43.4 µs | 42.5 µs | 7.66 µs | −82 % | 3081 → 882 → 12 |
| nums-500-flip | 41.2 µs | 44.3 µs | 8.39 µs | −80 % | 3081 → 877 → 3 |

**Array redesign (same day, after the user dropped "`arr[i] = v` must stay
tracked").** `bench/.builds/gaps-queue` vs 5.0.45, N = 8:

| unit | 5.0.45 | v6 | Δ |
|---|---|---|---|
| mutations/array-iterate/index (server `arr[i]`, 2000) | 177 µs | 7.45 µs | **−96 %** |
| mutations/array-refs/push-pop-100 | 1.54 µs | 0.45 µs | −71 % |
| mutations/array-refs/queue-push-shift-2000 (`QueueSchema`) | 4.76 µs | 0.48 µs | **−90 %** |
| mutations/array-refs/push-shift-2000 (`ArraySchema`) | 4.75 µs | 7.38 µs | +55 % |
| mutations/array-iterate/indexOf-last | 0.65 µs | 1.5 – 2.4 µs (two modes) | +130 … +270 % |
| decoder/array-read/indexOf-last | 0.64 µs | 1.49 µs | +134 % |
| decoder/array-read/for-of | 7.04 µs | 7.25 µs | +2.9 % |

- **No Proxy on the encoder side.** `new ArraySchema()` is the array.
  Against the `set`-only Proxy build (`gaps-sort2`): `arr[i]` −94 %,
  `encoder/construct` −33 %, `array-churn` −27 %, `heavy-tick` −19 %,
  `turn-based/enc` −21 %, push / pop −18 %, `memory-footprint` −3.4 %. The
  price: `arr[i] = v`, `arr.length = n`, `delete arr[i]` are untracked
  (`set()`, `splice()`, `clear()`); TypeScript reports them through a
  read-only index signature and `length`, plain JS does not — an untracked
  ref write surfaces as "cannot encode … without a refId", a primitive one
  as a silent desync. `ChangeTree.refTarget` and `$proxyTarget` are gone.
- **`QueueSchema`** (`t.queue()`): head offset + one native compaction when
  the dead front is half the storage; an array on the wire (PUSH /
  `REMOVE 0`), so decoders see an `ArraySchema`. Encoder sites that need the
  elements from index 0 read `ref[$elements]` (the queue compacts there).
  This is the answer to the `shift` rows; `ArraySchema#shift()` itself is
  unchanged (write barrier, §1).
- **`EXT` array op** (15): skippable by decoders that don't know the
  extension id; ops 12–14 unassigned.
- **Not built: ordered `@view()` arrays.** `ADD_REF`'s arg is reserved in
  `SPEC.md` for a position anchor and today's decoders already ignore it, so
  it can be added without a wire break. The encoder side needs the nearest
  preceding element visible to each view — one pass over the array per view
  with adds per tick — which is a cost to decide on, not a free win.
- `indexOf` stays a JS loop (the native builtin wants a plain-array
  receiver); the server row's two modes (1.8 / 2.4 µs) are the same on the
  Proxy build in isolation. Prototype-flipping to borrow the builtin leaves
  the array on a new hidden class every round trip — dead end. A plain array
  behind a `get` + `set` Proxy (5.x's model) was measured at `shift` 0.15 µs
  and `indexOf` 0.49 µs but 96 ns per `arr[i]` and +17 ns per method call;
  superseded by dropping the Proxy.

### Decode rows that moved without a cause (2026-11-10)

The full matrix of HEAD (`v6-f42fdb9`) against HEAD + the stub-tree change
(`UntrackedChangeTree` constants on the prototype, 128 → 64 B per decoded
ref) reported `big-state/decode-20k` +41 % and `inventory-rpg/dec` +8…12 %,
both reproducible, both with a clean A/A. Neither is a property of the code.

**`decode-20k`: scavenge phase locked to the loop.** One 20k decode allocated
14.7 MB of young objects (13.3 MB with the smaller stub) against a 16 MB
semi-space, so in a decode loop the scavenges land at a fixed phase per
build: on dead decoders in one (30 ms of GC per 40 ops), mid-decode on a
live graph in the other (216 ms). Sweeping `n`, HEAD is the slow build at
15k and 30k (47 ms vs 25 ms). With `--max-semi-space-size=64`, or a scavenge
before each op, the two builds are level. The decode rows of
`realworld/big-state` now set `coldYoungGen` (`bench/lib/child.mjs`): HEAD vs
stub change reads +0.6 % on `decode-20k`.

**`inventory-rpg/dec`: what the parallel scavenger leaves adjacent.** The
decode loop never reads or writes the moved fields (counted with getters on
the prototype: 0 in 2000 ticks), TurboFan optimises and inlines the same
functions in both builds, and a stand-alone script shows no gap. In the
harness the gap is all inside `decodeRun` (+1.8 µs / tick), it is HEAD that
slows down under `--single-threaded-gc` (15.6 → 18.0 µs; stub build 17.4 →
17.8), and with `--pad` every build from HEAD to the current tree lands at
15.5–16.1 µs. The `dec` / `callbacks` variants are now `layoutSensitive`.
The swing itself (~15 %) is the cost of the pointer chain per run member —
refs page → instance → stub tree → `$values` array → elements.

**What a full-state decode allocates** (20k entities + 100 players + 2000
tiles, sampling heap profiler, per decode):

| | before | after |
|---|---|---|
| short strings (`+=` char loop: a dead string per character) | 5.6 MB | 1.0 MB |
| instance + stub tree + `$values` (223 B / ref) | 4.8 MB | 4.8 MB |
| `Map.set` (`$items` + `indexByKey`, tables doubling) | 3.5 MB | 1.8 MB |
| boxed `number` values | 1.5 MB | 1.5 MB |
| total | 16.3 MB | 9.9 MB |

- **Short ASCII strings (1–12 bytes) in one `String.fromCharCode` call**
  (`decode.utf8Read`): 15–23 ns and 24–32 B per string against 28–170 ns and
  72–390 B for the `+=` loop, which is gone — everything else goes through
  the unit-array `apply`, or `TextDecoder` from 48 ASCII bytes.
- **A decoded map builds `indexByKey` on first read.** The decoder resolves
  ops by index (`keyByIndex`); key → index is only read by local `set()` /
  `delete()` and by an `Encoder` taking the state over. It stays unbuilt
  while index → key is one-to-one — a key seen twice builds it first.
- Against the tree before both (`gaps-final` → `dec-final`, N = 12,
  `bench/results/ab-gaps-final-vs-decode-opts.json`): `big-state/decode-20k`
  10.7 → 8.7 ms (−19 %), `decode-10k` −14 %, `decoder/map-bootstrap` −18 …
  −32 %, `bulk-add` −14 %, `resync` −7 %, `bootstrap` −7 %,
  `callbacks/map-churn/str` −10 %; steady-state decode rows unchanged.

Left open, largest first:

- **Boxed `number` fields.** Every non-integer float stored in `$values` is
  a fresh 16 B HeapNumber, and on a promoted instance an old → young store.
  With integer positions `inventory-rpg/dec` drops 15.6 → 12.1 µs / tick
  (−22 %). Needs unboxed storage for float fields (a `Float64Array` per
  instance or per class) on both sides — a storage redesign, not a patch.
- **Three objects per decoded Schema** (instance, `$values` array, 64 B
  stub tree: 223 B together). Folding the stub's four fields into the
  instance would save the 64 B and one hop of the chain above.
- **refId → tree table** next to `refs`, so a run member costs page → tree →
  `$values` without touching the instance. Unmeasured; bounded by the ~15 %
  layout swing.

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

(`index` −98 %, `length+at` −96 %, `spread` −8 % vs v5 are wins and did
not move; `for-of` is −38 % vs 5.0.31 but +12 % vs 5.0.45, see below;
`mutations/array-refs` push-pop / splice-head / unshift-pop are −2 … −36 %
vs v5 and another −4 % in round 2.)

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
- **`for-of` on the client (+12 % vs 5.0.45, measured 2026-11-10)**: 5.0.45
  returns the built-in iterator of its plain internal array, which TurboFan
  lowers to an indexed loop. v6's `ArrayValues` iterator costs ~0.5 ns per
  element over the subclass's own index loop (7.8 vs 6.8 µs for 2000). The
  built-in iterator on the subclass receiver misses that lowering: patching
  `Array.prototype[Symbol.iterator]` onto `ArraySchema.prototype` measured
  +170 % vs 5.0.45. The gap was +21 % before the November perf audit.

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
