# v6 PoC — measurements

Machine: darwin-arm64, Node v22.19.0, `bench/` harness, isolated child process
per sample, N = 20 samples per row, medians; every time row is significant at
p < .001 (Mann-Whitney U). Bytes are deterministic. v5 = `Encoder`/`Decoder`,
v6 = `Encoder6`/`Decoder6`, same build:

```
node bench/run.mjs --samples 20 --filter "<scenario>*" --json bench/results/codec-<scenario>.json
node bench/lib/codec-compare.mjs bench/results/codec-*.json
```

Bloat shape = `Map<Player{name, position{x,y}, scores[5]}>`; deep shape =
`State → Player → Item → Attribute` with `@view` tags (see `bench/lib/fixtures.mjs`).
`encoder/matrix` patches move the first 10 % / 100 % of players by fractional
steps (float32 payloads); `steady-tick` moves 10 / 100 players by integers.

| scenario/variant | unit | v5 | v6 | Δ time | v5 bytes | v6 bytes | Δ bytes |
|---|---|---:|---:|---:|---:|---:|---:|
| encoder/encode-all/default | ms/op | 4.071 | 2.388 | −41.3 % | 340 872 | 207 768 | −39.0 % |
| encoder/matrix/full-1000 | ms/op | 0.7918 | 0.4525 | −42.9 % | 64 872 | 36 862 | −43.2 % |
| encoder/matrix/full-2000 | ms/op | 1.605 | 0.9246 | −42.4 % | 133 872 | 78 768 | −41.2 % |
| decoder/bootstrap/default | ms/op | 3.579 | 3.196 | −10.7 % | 64 872 | 36 862 | −43.2 % |
| stateview/bootstrap/default | ms/op | 2.615 | 1.725 | −34.1 % | 180 443 | 128 754 | −28.6 % |
| decoder/resync/full | ms/frame | 3.623 | 3.156 | −12.9 % | 64 872 | 36 862 | −43.2 % |
| decoder/resync/churn | ms/frame | 3.558 | 3.147 | −11.5 % | 62 312 | 35 337 | −43.3 % |
| encoder/matrix/patch10pct-1000 | ms/op | 0.0143 | 0.0117 | −18.6 % | 1 373 | 1 358 | −1.1 % |
| encoder/matrix/patch10pct-2000 | ms/op | 0.0316 | 0.0274 | −13.4 % | 2 872 | 2 757 | −4.0 % |
| encoder/matrix/patch100pct-1000 | ms/op | 0.1570 | 0.1326 | −15.5 % | 14 802 | 13 887 | −6.2 % |
| encoder/matrix/patch100pct-2000 | ms/op | 0.3241 | 0.2741 | −15.4 % | 29 735 | 27 820 | −6.4 % |
| encoder/steady-tick/mut10 | ms/tick | 0.001711 | 0.001511 | −11.6 % | 100 | 100 | +0.0 % |
| encoder/steady-tick/mut100 | ms/tick | 0.0193 | 0.0169 | −12.6 % | 1 073 | 1 058 | −1.4 % |
| encoder/entity-churn/default | ms/cycle | 0.0580 | 0.0589 | +1.5 % | 804 | 457 | −43.2 % |
| decoder/tick/default | ms/frame | 0.5071 | 0.4796 | −5.4 % | – | – | – |
| decoder/churn/default | ms/frame | 0.0368 | 0.0348 | −5.6 % | – | – | – |
| callbacks/strategies/raw | ms/frame | 0.5249 | 0.5164 | −1.6 % | – | – | – |
| callbacks/strategies/state | ms/frame | 0.6127 | 0.6032 | −1.6 % | – | – | – |
| callbacks/strategies/legacy | ms/frame | 0.6157 | 0.6051 | −1.7 % | – | – | – |
| stateview/views/v1 | ms/tick | 0.008229 | 0.007551 | −8.2 % | 397 | 365 | −8.1 % |
| stateview/views/v10 | ms/tick | 0.0132 | 0.0104 | −21.3 % | 2 580 | 2 404 | −6.8 % |
| stateview/views/v50 | ms/tick | 0.0347 | 0.0198 | −42.8 % | 12 240 | 11 424 | −6.7 % |
| stateview/views/v100heavy | ms/tick | 0.1984 | 0.1011 | −49.1 % | 120 862 | 111 166 | −8.0 % |
| e2e/room-tick/default | ms/tick | 0.0457 | 0.0375 | −17.8 % | 1 349 | 1 248 | −7.5 % |

## Reading the table

- **Snapshots / joins / resync** are where the format changes bite: one
  nested root chunk instead of a switch header + per-field op byte per
  instance. −41…−43 % encode time, −29…−43 % bytes; the decoder gains
  −11…−13 % on bootstrap and resync (instance creation dominates there).
- **Patches** are byte-neutral to slightly smaller (the refId is 2 bytes
  instead of 3 once refIds pass 255; the float32 payloads dominate) and
  −12…−19 % encode time after the profile-driven pass below. `entity-churn`
  (+1.5 %) inlines ten fresh players per cycle at −43 % bytes.
- **Per-view encode** scales with client count: −8 % for one view, −43 % for
  50, −49 % for 100 views × 100 dirty entities (encode once per tick, memcpy
  per view, no concat of the shared region).
- **Decoder steady state** −5 % and callbacks −1.6 %: per-op work (setter,
  `refs.get`, `DataChange`) is unchanged by the format; the gain is the
  per-class reader table replacing the string-keyed type dispatch.

## How the encoder got there (V8 profile, `patch100pct-1000`)

Before tuning, per-field + value-writing self time was identical between v5
and v6 (~1 330 ms each) and all of a +9 % gap sat in per-chunk setup.
`--trace-turbo-inlining` showed the real cause: v5's field callback is
inlined into `forEachWithCtx`, while v6's never was — that call site is
shared by every recorder consumer in the process and had gone megamorphic.

1. v6 walks the recorder storage itself (`dirtyLow/High`, `ops`,
   `opsLow/High`, `collDirty`, `collPureOps`) with a direct per-field emitter,
   and the pass + tree state live on one frame object (v5 `EncodeCtx` shape).
2. Shared pass skips `IS_FILTERED` trees before touching them; `uvarint`
   1–2-byte fast paths inline, the loop out of line.
3. `number6`: byte-identical rewrite of v5's dynamic number writer (one
   float32 conversion, no `isNaN`/`isFinite`), fuzzed over 2 M values.
   Per-tree `emitMask` makes the field gate one AND; `ref[$values]` read once
   per tree; refId varint inline in `openChunk`.
4. Inlining-budget diet so the per-tree + per-field path inlines into
   `encodeQueue` (zero calls per tree, only `number6` per value): flag bits
   instead of getters, cold tails (≥ 32 fields, class filter, ≥ 0x4000
   refIds, ≥ 128-byte lengths) out of line. V8's 920-byte cumulative budget
   is a cliff: a small helper called from `encode()` itself is enough to push
   `enterFrame` out of the inline set (frame release now happens in
   `discardChanges`, off the chain).

Final encode profile: `encodeQueue` ≈ 650 ms + `number6` ≈ 300 ms vs v5
≈ 1 700 ms.

Didn't pay: `DataView.setFloat32` + `Math.fround` in `number6` (±0); trimming
bytecode by hoisting `it.offset++` into locals (barely shrank).

## Decoder robustness

Unknown refIds, truncated chunks and unknown field indexes are recovered
exactly (`test/v6/differential-misc.test.ts` #15) instead of by v5's
scan-for-`255` heuristic; during `decodeResync` any such damage aborts the
sweep rather than deleting live entries.


# 6.0 collections rewrite — A/B

Machine: win32-x64, Node v20.13.1, `bench/` harness, isolated child process
per sample, N = 10 samples per side, interleaved, medians; `p` is
Mann-Whitney U on wall-clock (✓ / ✗ = significant at p < .05, Δ < 0 means
the rewrite is faster). Bytes are deterministic. A = the `bfda4d9` snapshot
build behind a one-file shim that selects its codec (see README, "Wire
codec"); B = the rewrite (`ArraySchema extends Array` + op log, `MapSchema`
/ `SetSchema` on `KeyedRecorder`, single codec).

```
node bench/run.mjs --compare <snapshot>/build-poc ./build --samples 10 --filter "<group>/*" --json bench/results/ab-poc-<group>.json
node bench/run.mjs --compare <snapshot>/build-v5  ./build --samples 10 --filter "<group>/*" --json bench/results/ab-v5-<group>.json
```

## What the numbers say

- **Encoder**: every row faster than the proof of concept (7–34 %) and than
  v5 (patches 8–26 %, full syncs 39–44 %). Patch bytes are equal to the PoC;
  a full sync costs one extra byte per array (its revision, which the
  mid-tick-join gate needs). A per-tick `scores[0] = i` on 1 000 arrays
  (`heavy-tick`) is now 1 KB below the PoC and 2.8 KB below v5, after the
  op/operand fold and the on-demand `BASE`.
- **Decoder**: 20–63 % faster than both (no per-ADD `clone`, no `$onDecodeEnd`
  compaction, index-loop element moves). Callback strategies 25–31 % faster.
- **Views**: the `@view()` ring buffer (`stateview/array-reindex`) sends ~100
  bytes per tick for 4 views where the first rewrite pass sent 8 KB (the
  drain body now carries only the elements a view was just bound to) and
  where v5 sent 156; time is at parity with v5 and 6–11 % under the PoC.
  Custom tags (`stateview/tags`) are 25 % faster than the PoC after removing
  two allocations per cached chunk, but still 12 % slower than v5: the v6
  view pass (drain + per-view chunk cache) costs more than v5's straight
  walk when the payload is 20 tiny chunks per view. Many-view scenarios are
  33–56 % faster than v5.
- **Array mutations on the encoder side** (`mutations/array-refs`,
  `array-iterate`): push/pop, splice-at-head and unshift/pop are faster than
  both baselines; `shift()` on 2 000 Schema children is 2× slower (12 µs vs
  6 µs per tick). Cause: V8 takes the fast path of an `Array.prototype`
  builtin only when the receiver's prototype is the initial `Array.prototype`,
  so on an Array subclass `shift` / `splice` / `unshift` / `forEach` / `map` /
  `indexOf` … run the generic per-property algorithm (100× slower for a head
  removal, before this was addressed). `ArraySchema` now implements the
  mutators, the common read builtins and the iterators as index loops over
  the raw array (`src/types/custom/arrayOps.ts`); a head removal is one
  keyed-store slide (~5 ns per element) instead of a memmove.
- **Reads through the encoder-side Proxy** are the one cost that cannot be
  redirected: `arr[i]` costs ~70 ns (`array-iterate/index`, 144 µs per 2 000
  elements; v5 paid 265 µs through its `get` trap). `forEach` / `map` /
  `filter` / `for…of` unwrap once and run at 3–4 ns per element; `indexOf`
  is a strict-equality loop (2.2 µs vs 0.8 µs native on v5's internal plain
  array). Documented in the CHANGELOG: walk a large array on the server with
  `forEach`, `for…of` or `toArray()`, not an index loop.
- `encoder/string-heavy` is 13 % slower than v5 (2 % fewer bytes) and 12 %
  faster than the PoC: the v6 `writeString` (length prefix + `encodeInto`)
  is the difference, not the collections.

### 6.0 collections rewrite vs v6 proof of concept

| scenario/variant | unit | A | B | Δ time | p | A bytes | B bytes |
|---|---|---:|---:|---:|---:|---:|---:|
| callbacks/strategies/legacy | ms/frame | 0.8197 | 0.6126 | −25.3 % ✓ | <.001 | – | – |
| callbacks/strategies/raw | ms/frame | 0.7055 | 0.4868 | −31.0 % ✓ | <.001 | – | – |
| callbacks/strategies/state | ms/frame | 0.8278 | 0.5914 | −28.6 % ✓ | <.001 | – | – |
| decoder/bootstrap/default | ms/op | 5.84 | 3.60 | −38.4 % ✓ | <.001 | 36 862 | 37 862 |
| decoder/churn/default | ms/frame | 0.0551 | 0.0440 | −20.2 % ✓ | <.001 | – | – |
| decoder/deep-nested/default | ms/frame | 0.0327 | 0.0329 | +0.8 % | 0.104 | – | – |
| decoder/resync/churn | ms/frame | 5.22 | 2.10 | −59.8 % ✓ | <.001 | 35 337 | 36 287 |
| decoder/resync/full | ms/frame | 5.21 | 1.94 | −62.8 % ✓ | <.001 | 36 862 | 37 862 |
| decoder/tick/default | ms/frame | 0.6472 | 0.4395 | −32.1 % ✓ | <.001 | – | – |
| e2e/room-tick/default | ms/tick | 0.0468 | 0.0456 | −2.6 % | 0.140 | 1 248 | 1 248 |
| encoder/array-churn/default | ms/tick | 9.93e-4 | 6.60e-4 | −33.5 % ✓ | <.001 | 4 | 0 |
| encoder/construct/default | µs/entity | 6.70 | 5.51 | −17.6 % ✓ | 0.021 | 0 | 0 |
| encoder/deep-nested/default | ms/tick | 8.75 | 8.54 | −2.4 % ✓ | 0.045 | 54 089 | 54 589 |
| encoder/encode-all/default | ms/op | 3.78 | 3.35 | −11.4 % ✓ | <.001 | 207 768 | 212 768 |
| encoder/entity-churn/default | ms/cycle | 0.0973 | 0.0898 | −7.7 % ✓ | <.001 | 457 | 467 |
| encoder/heavy-tick/default | ms/tick | 0.6380 | 0.5892 | −7.7 % ✓ | <.001 | 18 770 | 17 770 |
| encoder/matrix/full-1000 | ms/op | 0.6529 | 0.5771 | −11.6 % ✓ | <.001 | 36 862 | 37 862 |
| encoder/matrix/full-2000 | ms/op | 1.35 | 1.23 | −9.0 % ✓ | <.001 | 78 768 | 80 768 |
| encoder/matrix/patch100pct-1000 | ms/op | 0.1317 | 0.1157 | −12.2 % ✓ | <.001 | 13 887 | 13 887 |
| encoder/matrix/patch100pct-2000 | ms/op | 0.3105 | 0.2477 | −20.2 % ✓ | <.001 | 27 820 | 27 820 |
| encoder/matrix/patch10pct-1000 | ms/op | 0.0135 | 0.0116 | −13.8 % ✓ | <.001 | 1 358 | 1 358 |
| encoder/matrix/patch10pct-2000 | ms/op | 0.0274 | 0.0237 | −13.6 % ✓ | <.001 | 2 757 | 2 757 |
| encoder/memory-footprint/default | KB | 2621 | 2407 | −8.2 % ✓ | <.001 | – | – |
| encoder/steady-tick/mut10 | ms/tick | 2.03e-3 | 1.78e-3 | −12.4 % ✓ | <.001 | 100 | 100 |
| encoder/steady-tick/mut100 | ms/tick | 0.0165 | 0.0147 | −11.0 % ✓ | <.001 | 1 058 | 1 058 |
| encoder/string-heavy/default | ms/tick | 0.0272 | 0.0240 | −11.6 % ✓ | <.001 | 3 858 | 3 858 |
| mutations/array-iterate/filter | µs/op | 5.89 | 7.20 | +22.2 % ✗ | <.001 | – | – |
| mutations/array-iterate/for-of | µs/op | 4.67 | 8.97 | +92.2 % ✗ | 0.026 | – | – |
| mutations/array-iterate/forEach | µs/op | 5.38 | 6.33 | +17.6 % ✗ | <.001 | – | – |
| mutations/array-iterate/index | µs/op | 266 | 144 | −46.1 % ✓ | <.001 | – | – |
| mutations/array-iterate/indexOf-last | µs/op | 0.7469 | 2.22 | +196.8 % ✗ | <.001 | – | – |
| mutations/array-iterate/map | µs/op | 5.66 | 5.91 | +4.5 % ✗ | <.001 | – | – |
| mutations/array-iterate/shift-push | µs/op | 5.00 | 11.3 | +126.2 % ✗ | <.001 | – | – |
| mutations/array-refs/push-pop-100 | ms/tick | 2.60e-3 | 2.19e-3 | −15.6 % ✓ | <.001 | 6 | 0 |
| mutations/array-refs/push-pop-2000 | ms/tick | 0.1775 | 0.1714 | −3.4 % ✓ | <.001 | 5 | 0 |
| mutations/array-refs/push-shift-100 | ms/tick | 3.36e-3 | 3.09e-3 | −7.9 % ✓ | <.001 | 16 | 13 |
| mutations/array-refs/push-shift-2000 | ms/tick | 6.88e-3 | 0.0121 | +76.3 % ✗ | <.001 | 15 | 12 |
| mutations/array-refs/splice-head-500 | ms/tick | 8.24e-3 | 5.19e-3 | −37.0 % ✓ | <.001 | 15 | 12 |
| mutations/array-refs/unshift-pop-500 | ms/tick | 5.83e-3 | 5.12e-3 | −12.2 % ✓ | <.001 | 14 | 14 |
| stateview/array-reindex/pop-1000 | ms/tick | 0.0534 | 0.0478 | −10.4 % ✓ | <.001 | 97 | 101 |
| stateview/array-reindex/shift-100 | ms/tick | 0.0121 | 0.0113 | −6.0 % ✓ | 0.038 | 103 | 107 |
| stateview/array-reindex/shift-1000 | ms/tick | 0.0182 | 0.0163 | −10.6 % ✓ | 0.005 | 97 | 100 |
| stateview/bootstrap/default | ms/op | 2.35 | 2.07 | −12.1 % ✓ | <.001 | 128 754 | 129 754 |
| stateview/tags/default | ms/tick | 0.0422 | 0.0316 | −25.0 % ✓ | <.001 | 2 385 | 2 385 |
| stateview/view-churn/default | ms/tick | 0.6106 | 0.5551 | −9.1 % ✓ | <.001 | 13 089 | 13 189 |
| stateview/views/v1 | ms/tick | 9.01e-3 | 8.90e-3 | −1.2 % ✓ | 0.004 | 365 | 365 |
| stateview/views/v10 | ms/tick | 0.0146 | 0.0131 | −10.0 % ✓ | <.001 | 2 404 | 2 404 |
| stateview/views/v100heavy | ms/tick | 0.1163 | 0.1109 | −4.6 % ✓ | <.001 | 111 166 | 111 166 |
| stateview/views/v50 | ms/tick | 0.0267 | 0.0278 | +3.9 % ✗ | <.001 | 11 424 | 11 424 |

### 6.0 collections rewrite vs v5

| scenario/variant | unit | A | B | Δ time | p | A bytes | B bytes |
|---|---|---:|---:|---:|---:|---:|---:|
| callbacks/strategies/legacy | ms/frame | 0.8202 | 0.5993 | −26.9 % ✓ | <.001 | – | – |
| callbacks/strategies/raw | ms/frame | 0.7176 | 0.4930 | −31.3 % ✓ | <.001 | – | – |
| callbacks/strategies/state | ms/frame | 0.8310 | 0.6022 | −27.5 % ✓ | <.001 | – | – |
| decoder/bootstrap/default | ms/op | 6.30 | 3.58 | −43.2 % ✓ | <.001 | 64 872 | 37 862 |
| decoder/churn/default | ms/frame | 0.0553 | 0.0436 | −21.1 % ✓ | <.001 | – | – |
| decoder/deep-nested/default | ms/frame | 0.0345 | 0.0330 | −4.2 % ✓ | <.001 | – | – |
| decoder/resync/churn | ms/frame | 5.76 | 2.10 | −63.6 % ✓ | <.001 | 62 312 | 36 287 |
| decoder/resync/full | ms/frame | 5.83 | 1.94 | −66.7 % ✓ | <.001 | 64 872 | 37 862 |
| decoder/tick/default | ms/frame | 0.6808 | 0.4425 | −35.0 % ✓ | <.001 | – | – |
| e2e/room-tick/default | ms/tick | 0.0597 | 0.0451 | −24.4 % ✓ | <.001 | 1 349 | 1 248 |
| encoder/array-churn/default | ms/tick | 8.50e-4 | 6.64e-4 | −21.8 % ✓ | <.001 | 4 | 0 |
| encoder/construct/default | µs/entity | 5.55 | 4.92 | −11.3 % | 0.054 | 0 | 0 |
| encoder/deep-nested/default | ms/tick | 8.13 | 7.69 | −5.4 % ✓ | <.001 | 89 545 | 54 589 |
| encoder/encode-all/default | ms/op | 5.17 | 3.16 | −38.9 % ✓ | <.001 | 340 872 | 212 768 |
| encoder/entity-churn/default | ms/cycle | 0.0912 | 0.0844 | −7.4 % ✓ | <.001 | 804 | 467 |
| encoder/heavy-tick/default | ms/tick | 0.6265 | 0.5742 | −8.3 % ✓ | <.001 | 20 601 | 17 770 |
| encoder/matrix/full-1000 | ms/op | 1.00 | 0.5612 | −44.1 % ✓ | <.001 | 64 872 | 37 862 |
| encoder/matrix/full-2000 | ms/op | 2.04 | 1.20 | −41.0 % ✓ | <.001 | 133 872 | 80 768 |
| encoder/matrix/patch100pct-1000 | ms/op | 0.1457 | 0.1139 | −21.9 % ✓ | <.001 | 14 802 | 13 887 |
| encoder/matrix/patch100pct-2000 | ms/op | 0.3385 | 0.2515 | −25.7 % ✓ | <.001 | 29 735 | 27 820 |
| encoder/matrix/patch10pct-1000 | ms/op | 0.0145 | 0.0115 | −20.7 % ✓ | <.001 | 1 373 | 1 358 |
| encoder/matrix/patch10pct-2000 | ms/op | 0.0286 | 0.0227 | −20.5 % ✓ | <.001 | 2 872 | 2 757 |
| encoder/memory-footprint/default | KB | 2633 | 2536 | −3.7 % ✓ | <.001 | – | – |
| encoder/steady-tick/mut10 | ms/tick | 1.90e-3 | 1.75e-3 | −7.9 % ✓ | <.001 | 100 | 100 |
| encoder/steady-tick/mut100 | ms/tick | 0.0170 | 0.0145 | −14.4 % ✓ | <.001 | 1 073 | 1 058 |
| encoder/string-heavy/default | ms/tick | 0.0214 | 0.0241 | +12.8 % ✗ | <.001 | 3 929 | 3 858 |
| mutations/array-iterate/filter | µs/op | 5.87 | 7.13 | +21.4 % ✗ | <.001 | – | – |
| mutations/array-iterate/for-of | µs/op | 14.5 | 8.72 | −40.0 % ✓ | 0.026 | – | – |
| mutations/array-iterate/forEach | µs/op | 4.26 | 6.25 | +46.6 % ✗ | <.001 | – | – |
| mutations/array-iterate/index | µs/op | 266 | 144 | −45.7 % ✓ | <.001 | – | – |
| mutations/array-iterate/indexOf-last | µs/op | 0.7627 | 2.21 | +190.4 % ✗ | <.001 | – | – |
| mutations/array-iterate/map | µs/op | 5.58 | 6.06 | +8.7 % ✗ | 0.001 | – | – |
| mutations/array-iterate/shift-push | µs/op | 4.84 | 11.3 | +133.5 % ✗ | <.001 | – | – |
| mutations/array-refs/push-pop-100 | ms/tick | 2.50e-3 | 2.14e-3 | −14.4 % ✓ | <.001 | 7 | 0 |
| mutations/array-refs/push-pop-2000 | ms/tick | 0.1728 | 0.1696 | −1.9 % ✓ | <.001 | 6 | 0 |
| mutations/array-refs/push-shift-100 | ms/tick | 2.97e-3 | 3.07e-3 | +3.4 % ✗ | 0.001 | 23 | 13 |
| mutations/array-refs/push-shift-2000 | ms/tick | 6.01e-3 | 0.0122 | +102.3 % ✗ | <.001 | 21 | 12 |
| mutations/array-refs/splice-head-500 | ms/tick | 7.94e-3 | 5.20e-3 | −34.5 % ✓ | <.001 | 21 | 12 |
| mutations/array-refs/unshift-pop-500 | ms/tick | 5.80e-3 | 5.16e-3 | −11.0 % ✓ | <.001 | 19 | 14 |
| stateview/array-reindex/pop-1000 | ms/tick | 0.0525 | 0.0482 | −8.3 % ✓ | <.001 | 156 | 101 |
| stateview/array-reindex/shift-100 | ms/tick | 0.0107 | 0.0106 | −1.0 % | 0.345 | 158 | 107 |
| stateview/array-reindex/shift-1000 | ms/tick | 0.0159 | 0.0159 | −0.5 % | 1.000 | 156 | 100 |
| stateview/bootstrap/default | ms/op | 3.40 | 2.07 | −38.9 % ✓ | <.001 | 180 443 | 129 754 |
| stateview/tags/default | ms/tick | 0.0289 | 0.0324 | +11.8 % ✗ | <.001 | 2 385 | 2 385 |
| stateview/view-churn/default | ms/tick | 0.6776 | 0.5530 | −18.4 % ✓ | <.001 | 18 610 | 13 189 |
| stateview/views/v1 | ms/tick | 9.47e-3 | 8.76e-3 | −7.5 % ✓ | <.001 | 397 | 365 |
| stateview/views/v10 | ms/tick | 0.0196 | 0.0132 | −32.9 % ✓ | <.001 | 2 580 | 2 404 |
| stateview/views/v100heavy | ms/tick | 0.2498 | 0.1092 | −56.3 % ✓ | <.001 | 120 862 | 111 166 |
| stateview/views/v50 | ms/tick | 0.0574 | 0.0276 | −51.9 % ✓ | <.001 | 12 240 | 11 424 |


# MapSchema rewrite — A/B (keyed-op fold + typed keys)

Machine: win32-x64, Node v20.13.1, `bench/` harness, isolated child process
per sample, interleaved ABBA, medians; `p` is Mann-Whitney U on wall-clock
(✓ / ✗ = significant at p < .05, Δ < 0 means B faster). Bytes are
deterministic and printed per side (they differ by design: that is the wire
change). A = the baseline named in each table's heading, B = this change
(`bench/.builds/map-keys-3`).

- **v5** = the `bfda4d9` snapshot behind the `build-v5` shim (5.0.23
  collections, v5 codec).
- **6.0-pre** = the 6.0 tree before this change (`a7e4b21`, frozen as
  `bench/.builds/v6-head`), which isolates the map work from the array rewrite.

The map scenarios (`encoder/map-*`, `decoder/map-*`, `callbacks/map-churn`,
`mutations/map-ops`, 15 samples per side) use `State { players: Map<Player{name,
position{x,y}}>, scores: Map<number> }` keyed by 8-char strings (`str`) or by
integers declared `key: "number"` (`num`; a build without typed keys
stringifies them, so its `num` rows carry short string keys). The regression
sweep re-runs the existing map-backed matrix against 6.0-pre (10 samples).

```
node bench/run.mjs --compare <baseline> bench/.builds/map-keys-3 --samples 15 --filter "<group>/map-*" --json bench/results/ab3-<baseline>-map-<group>.json
node bench/run.mjs --compare bench/.builds/v6-head bench/.builds/map-keys-3 --samples 10 --filter "<scenario>" --json bench/results/ab3-v6head-sweep-<scenario>.json
```

## What the numbers say

- **Full syncs** of a map: −34…−53 % time and −13…−33 % bytes against v5;
  against 6.0-pre the body path is −2.5 % (string keys, same bytes) and −24 %
  with number keys (a 10 000-entry `Map<number, number>` snapshot is 79 KB
  instead of 98 KB; on v5 it was 118 KB).
- **REPLACE ticks** (`Map<string, number>`, the hottest primitive-map op):
  −15…−26 % time and −16…−25 % bytes against v5. Against 6.0-pre the op fold
  makes each op one byte shorter (4 971 vs 5 875 bytes for 1 000 entries) at
  the same time for string keys, and −10…−16 % time with number keys.
- **Churn** (delete 10 / re-add 10 players per cycle): encode at parity
  (−2…+2 %) with −30…−37 % bytes against v5; decode −1…+3 % against 6.0-pre
  (the scenario's A/A noise floor is ±4 %: `decoder/map-churn/num` measured
  the pre-change build 3.8 % "slower" than itself). Against v5 the churn
  *decode* is +15 %: that gap was already there before this change (the 6.0
  inline-body ADD does more per entry than the 5.x per-field walk) and is
  unchanged by it. `callbacks/map-churn` reads +7…+10 % against 6.0-pre with
  a tight A/A (±0.4 %); a counting probe shows byte-identical decoder work
  (same instance creations, ref releases, callbacks) and the existing
  `callbacks/add-remove-churn` in the sweep is neutral, so this row is
  reported as unresolved rather than explained.
- **Typed keys**: `Map<number, V>` costs nothing extra on the wire beyond the
  number itself (1–5 bytes vs 9 for an 8-char string on every ADD) and turns
  key reads into integer lookups: `get` −20 %, `has` −46 %, `set` on an
  existing key −6 % (`mutations/map-ops`). Callbacks receive the number.
- **API** (`mutations/map-ops`, string keys): parity with 6.0-pre on every
  op. `set` on an existing string key is +7 % against v5 — that is the 6.0
  `KeyedRecorder` merge and predates this change (6.0-pre reads the same).
- **Regression sweep** (existing map-backed matrix vs 6.0-pre): every row
  within ±2 % or not significant; bytes identical except `entity-churn`
  (458 vs 467, the fold). `stateview/views/v10` +4.6 % (p = .001) on a
  14 µs tick is the one significant reading above 2 %; `v1` / `v50` /
  `v100heavy` are flat.

## Lessons

- A first cut used a 3-bit op field (`uvarint(index * 8 + op)`) so `CLEAR`
  and `DELETE_AND_ADD` could both ride the wire. Wire indexes are never
  recycled, so a churned map passes index 2 048 within a few hundred cycles
  and every op grew to three bytes — measured as +8…+17 % on churn decode.
  The shipped layout is two bits (`index * 4 + op`, REPLACE / DELETE / ADD /
  CLEAR): `DELETE_AND_ADD` is derived by the decoder from an ADD onto an
  occupied index, and an op stays two bytes up to index 8 191 (the previous
  op-byte + index layout stayed two bytes up to 16 383 and was never smaller).
- Recycling wire indexes after their DELETE has shipped would keep indexes
  bounded by the live size and is the natural follow-up; it needs the
  per-view `changes` drain to re-check visibility (a stale entry for a
  recycled index would otherwise ADD the new occupant to that view).

## vs v5 (map scenarios)

| scenario/variant | unit | A | B | Δ time | p | A bytes | B bytes |
|---|---|---:|---:|---:|---:|---:|---:|
| callbacks/map-churn/num | ms/frame | 0.0250 | 0.0280 | +12.2 % ✗ | <.001 | – | – |
| callbacks/map-churn/str | ms/frame | 0.0267 | 0.0291 | +9.0 % ✗ | <.001 | – | – |
| decoder/map-bootstrap/players-num-1000 | ms/op | 2.25 | 2.19 | −2.7 % ✓ | <.001 | 40 878 | 26 592 |
| decoder/map-bootstrap/players-str-1000 | ms/op | 2.41 | 2.39 | −1.1 % | 0.115 | 45 988 | 32 976 |
| decoder/map-bootstrap/scores-num-10000 | ms/op | 1.89 | 1.40 | −26.3 % ✓ | <.001 | 118 128 | 79 115 |
| decoder/map-bootstrap/scores-str-10000 | ms/op | 3.69 | 2.73 | −25.9 % ✓ | <.001 | 158 734 | 139 067 |
| decoder/map-churn/num | ms/frame | 0.0192 | 0.0221 | +15.3 % ✗ | <.001 | 241 | 167 |
| decoder/map-churn/str | ms/frame | 0.0194 | 0.0227 | +16.8 % ✗ | <.001 | 266 | 198 |
| decoder/map-replace/num-100pct | ms/frame | 0.0497 | 0.0228 | −54.1 % ✓ | <.001 | 6 199 | 4 578 |
| decoder/map-replace/str-100pct | ms/frame | 0.0565 | 0.0365 | −35.5 % ✓ | <.001 | 6 199 | 4 578 |
| encoder/map-churn/num-100 | ms/cycle | 0.0412 | 0.0430 | +4.5 % ✗ | <.001 | 573 | 361 |
| encoder/map-churn/num-1000 | ms/cycle | 0.0440 | 0.0446 | +1.3 % ✗ | 0.003 | 584 | 377 |
| encoder/map-churn/str-100 | ms/cycle | 0.0470 | 0.0474 | +0.7 % | 0.300 | 634 | 441 |
| encoder/map-churn/str-1000 | ms/cycle | 0.0497 | 0.0488 | −1.7 % | 0.051 | 635 | 441 |
| encoder/map-encode-all/players-num-1000 | ms/op | 0.471 | 0.241 | −48.9 % ✓ | <.001 | 40 878 | 26 592 |
| encoder/map-encode-all/players-str-1000 | ms/op | 0.517 | 0.278 | −46.1 % ✓ | <.001 | 45 988 | 32 976 |
| encoder/map-encode-all/scores-num-10000 | ms/op | 0.819 | 0.386 | −52.8 % ✓ | <.001 | 118 128 | 79 115 |
| encoder/map-encode-all/scores-str-10000 | ms/op | 1.09 | 0.718 | −34.2 % ✓ | <.001 | 158 734 | 139 067 |
| encoder/map-replace/num-100pct | ms/tick | 0.126 | 0.103 | −18.3 % ✓ | <.001 | 6 618 | 4 971 |
| encoder/map-replace/num-10pct | ms/tick | 0.0132 | 0.0103 | −21.7 % ✓ | <.001 | 502 | 471 |
| encoder/map-replace/str-100pct | ms/tick | 0.269 | 0.201 | −25.5 % ✓ | <.001 | 6 618 | 4 971 |
| encoder/map-replace/str-10pct | ms/tick | 0.0260 | 0.0222 | −14.9 % ✓ | <.001 | 502 | 471 |
| mutations/map-ops/add-delete-num | µs/op | 357.6 | 359.9 | +0.6 % ✗ | 0.011 | – | – |
| mutations/map-ops/add-delete-str | µs/op | 407.5 | 393.4 | −3.5 % ✓ | 0.001 | – | – |
| mutations/map-ops/for-of-num | µs/op | 6.74 | 6.79 | +0.7 % | 0.803 | – | – |
| mutations/map-ops/for-of-str | µs/op | 6.77 | 6.79 | +0.3 % | 1.000 | – | – |
| mutations/map-ops/forEach-num | µs/op | 7.58 | 7.62 | +0.4 % | 0.534 | – | – |
| mutations/map-ops/forEach-str | µs/op | 7.65 | 7.71 | +0.8 % | 0.590 | – | – |
| mutations/map-ops/get-num | µs/op | 9.40 | 7.56 | −19.6 % ✓ | <.001 | – | – |
| mutations/map-ops/get-str | µs/op | 18.9 | 19.5 | +3.4 % ✗ | 0.013 | – | – |
| mutations/map-ops/has-num | µs/op | 6.29 | 3.37 | −46.4 % ✓ | <.001 | – | – |
| mutations/map-ops/has-str | µs/op | 13.0 | 13.0 | −0.1 % | 0.934 | – | – |
| mutations/map-ops/keys-num | µs/op | 1.61 | 1.60 | −0.4 % | 0.384 | – | – |
| mutations/map-ops/keys-str | µs/op | 1.63 | 1.63 | +0.3 % | 0.507 | – | – |
| mutations/map-ops/set-replace-num | µs/op | 65.1 | 64.2 | −1.4 % ✓ | 0.002 | – | – |
| mutations/map-ops/set-replace-str | µs/op | 79.8 | 85.4 | +7.0 % ✗ | <.001 | – | – |

## vs 6.0-pre (map scenarios)

| scenario/variant | unit | A | B | Δ time | p | A bytes | B bytes |
|---|---|---:|---:|---:|---:|---:|---:|
| callbacks/map-churn/num | ms/frame | 0.0255 | 0.0273 | +6.8 % ✗ | <.001 | – | – |
| callbacks/map-churn/str | ms/frame | 0.0261 | 0.0287 | +9.9 % ✗ | <.001 | – | – |
| decoder/map-bootstrap/players-num-1000 | ms/op | 2.31 | 2.18 | −5.7 % ✓ | <.001 | 27 866 | 26 592 |
| decoder/map-bootstrap/players-str-1000 | ms/op | 2.39 | 2.37 | −0.8 % ✓ | 0.025 | 32 976 | 32 976 |
| decoder/map-bootstrap/scores-num-10000 | ms/op | 1.87 | 1.34 | −28.2 % ✓ | <.001 | 98 389 | 79 115 |
| decoder/map-bootstrap/scores-str-10000 | ms/op | 2.60 | 2.59 | −0.5 % | 0.068 | 139 067 | 139 067 |
| decoder/map-churn/num | ms/frame | 0.0211 | 0.0216 | +2.2 % | 0.056 | 180 | 167 |
| decoder/map-churn/str | ms/frame | 0.0219 | 0.0225 | +2.5 % ✗ | 0.003 | 205 | 198 |
| decoder/map-replace/num-100pct | ms/frame | 0.0313 | 0.0228 | −27.3 % ✓ | <.001 | 5 468 | 4 578 |
| decoder/map-replace/str-100pct | ms/frame | 0.0369 | 0.0368 | −0.4 % | 0.678 | 5 468 | 4 578 |
| encoder/map-churn/num-100 | ms/cycle | 0.0447 | 0.0440 | −1.5 % ✓ | 0.007 | 398 | 361 |
| encoder/map-churn/num-1000 | ms/cycle | 0.0465 | 0.0461 | −0.9 % ✓ | 0.046 | 408 | 377 |
| encoder/map-churn/str-100 | ms/cycle | 0.0482 | 0.0492 | +2.0 % | 0.115 | 459 | 441 |
| encoder/map-churn/str-1000 | ms/cycle | 0.0512 | 0.0500 | −2.4 % ✓ | 0.010 | 459 | 441 |
| encoder/map-encode-all/players-num-1000 | ms/op | 0.272 | 0.245 | −9.9 % ✓ | <.001 | 27 866 | 26 592 |
| encoder/map-encode-all/players-str-1000 | ms/op | 0.284 | 0.288 | +1.6 % | 0.125 | 32 976 | 32 976 |
| encoder/map-encode-all/scores-num-10000 | ms/op | 0.523 | 0.398 | −23.9 % ✓ | <.001 | 98 389 | 79 115 |
| encoder/map-encode-all/scores-str-10000 | ms/op | 0.777 | 0.757 | −2.5 % ✓ | <.001 | 139 067 | 139 067 |
| encoder/map-replace/num-100pct | ms/tick | 0.111 | 0.100 | −10.2 % ✓ | <.001 | 5 875 | 4 971 |
| encoder/map-replace/num-10pct | ms/tick | 0.0122 | 0.0103 | −15.5 % ✓ | <.001 | 503 | 471 |
| encoder/map-replace/str-100pct | ms/tick | 0.197 | 0.201 | +1.9 % ✗ | <.001 | 5 875 | 4 971 |
| encoder/map-replace/str-10pct | ms/tick | 0.0227 | 0.0220 | −3.0 % ✓ | 0.002 | 503 | 471 |
| mutations/map-ops/add-delete-num | µs/op | 361.1 | 357.9 | −0.9 % ✓ | 0.009 | – | – |
| mutations/map-ops/add-delete-str | µs/op | 478.5 | 472.5 | −1.3 % | 0.361 | – | – |
| mutations/map-ops/for-of-num | µs/op | 6.74 | 6.81 | +1.0 % | 0.125 | – | – |
| mutations/map-ops/for-of-str | µs/op | 7.14 | 7.12 | −0.2 % | 0.803 | – | – |
| mutations/map-ops/forEach-num | µs/op | 7.57 | 7.60 | +0.4 % | 0.171 | – | – |
| mutations/map-ops/forEach-str | µs/op | 7.73 | 7.85 | +1.6 % | 0.481 | – | – |
| mutations/map-ops/get-num | µs/op | 9.38 | 7.49 | −20.2 % ✓ | <.001 | – | – |
| mutations/map-ops/get-str | µs/op | 18.8 | 19.0 | +1.3 % | 0.455 | – | – |
| mutations/map-ops/has-num | µs/op | 6.33 | 3.39 | −46.5 % ✓ | <.001 | – | – |
| mutations/map-ops/has-str | µs/op | 13.2 | 13.2 | +0.1 % | 0.901 | – | – |
| mutations/map-ops/keys-num | µs/op | 1.62 | 1.62 | +0.0 % | 0.967 | – | – |
| mutations/map-ops/keys-str | µs/op | 1.64 | 1.64 | −0.1 % | 0.709 | – | – |
| mutations/map-ops/set-replace-num | µs/op | 67.7 | 63.7 | −5.8 % ✓ | <.001 | – | – |
| mutations/map-ops/set-replace-str | µs/op | 88.2 | 88.1 | −0.1 % | 0.340 | – | – |

## Regression sweep vs 6.0-pre (existing map-backed matrix)

| scenario/variant | unit | A | B | Δ time | p | A bytes | B bytes |
|---|---|---:|---:|---:|---:|---:|---:|
| callbacks/add-remove-churn/default | ms/frame | 0.0538 | 0.0539 | +0.1 % | 0.678 | – | – |
| callbacks/density/dense | ms/frame | 0.583 | 0.584 | +0.2 % | 0.571 | – | – |
| callbacks/density/none | ms/frame | 0.486 | 0.487 | +0.2 % | 0.678 | – | – |
| callbacks/density/sparse1pct | ms/frame | 0.490 | 0.489 | −0.2 % | 0.678 | – | – |
| callbacks/strategies/legacy | ms/frame | 0.584 | 0.580 | −0.6 % | 0.273 | – | – |
| callbacks/strategies/raw | ms/frame | 0.482 | 0.486 | +0.8 % | 0.427 | – | – |
| callbacks/strategies/state | ms/frame | 0.594 | 0.593 | −0.3 % | 0.678 | – | – |
| decoder/bootstrap/default | ms/op | 3.61 | 3.59 | −0.5 % | 0.571 | 37 862 | 37 862 |
| decoder/churn/default | ms/frame | 0.0453 | 0.0485 | +7.0 % | 0.385 | – | – |
| decoder/resync/churn | ms/frame | 2.11 | 2.11 | −0.3 % | 0.571 | 36 287 | 36 287 |
| decoder/resync/full | ms/frame | 1.95 | 1.95 | −0.0 % | 0.571 | 37 862 | 37 862 |
| decoder/tick/default | ms/frame | 0.428 | 0.432 | +0.9 % ✗ | 0.014 | – | – |
| e2e/room-tick/default | ms/tick | 0.0457 | 0.0461 | +0.9 % | 0.241 | 1 248 | 1 248 |
| encoder/encode-all/default | ms/op | 3.10 | 3.17 | +2.2 % ✗ | 0.021 | 212 768 | 212 768 |
| encoder/entity-churn/default | ms/cycle | 0.0854 | 0.0857 | +0.4 % | 0.121 | 467 | 458 |
| encoder/heavy-tick/default | ms/tick | 0.577 | 0.584 | +1.3 % ✗ | 0.045 | 17 770 | 17 770 |
| encoder/matrix/full-1000 | ms/op | 0.569 | 0.578 | +1.7 % | 0.140 | 37 862 | 37 862 |
| encoder/matrix/full-2000 | ms/op | 1.23 | 1.22 | −1.0 % | 0.307 | 80 768 | 80 768 |
| encoder/matrix/patch100pct-1000 | ms/op | 0.112 | 0.113 | +1.1 % | 0.104 | 13 887 | 13 887 |
| encoder/matrix/patch100pct-2000 | ms/op | 0.246 | 0.247 | +0.3 % | 0.791 | 27 820 | 27 820 |
| encoder/matrix/patch10pct-1000 | ms/op | 0.0120 | 0.0118 | −1.8 % | 0.623 | 1 358 | 1 358 |
| encoder/matrix/patch10pct-2000 | ms/op | 0.0235 | 0.0236 | +0.7 % | 0.678 | 2 757 | 2 757 |
| encoder/steady-tick/mut10 | ms/tick | 0.00182 | 0.00180 | −1.0 % | 0.307 | 100 | 100 |
| encoder/steady-tick/mut100 | ms/tick | 0.0146 | 0.0148 | +0.8 % | 0.427 | 1 058 | 1 058 |
| stateview/bootstrap/default | ms/op | 2.10 | 2.13 | +1.2 % | 0.385 | 129 754 | 129 754 |
| stateview/view-churn/default | ms/tick | 0.591 | 0.593 | +0.5 % | 0.678 | 13 189 | 13 189 |
| stateview/views/v1 | ms/tick | 0.00894 | 0.00907 | +1.4 % | 0.162 | 365 | 365 |
| stateview/views/v10 | ms/tick | 0.0136 | 0.0142 | +4.6 % ✗ | 0.001 | 2 404 | 2 404 |
| stateview/views/v100heavy | ms/tick | 0.112 | 0.114 | +1.6 % | 0.791 | 111 166 | 111 166 |
| stateview/views/v50 | ms/tick | 0.0289 | 0.0288 | −0.3 % | 0.571 | 11 424 | 11 424 |

# Construction and attach — A/B (refId on the tree, private tree slot)

Machine: win32-x64, Node v22.23.2, `bench/` harness, isolated child process
per sample, interleaved ABBA, medians; `p` is Mann-Whitney U on wall-clock
(Δ < 0 means B faster). A = the 6.0 tree before this change (`a7e4b21` plus the
working tree, frozen as `bench/.builds/R3-base`), B = this change
(`bench/.builds/R3-S5`; `R3-S6` for the `stateview` / `entities-aoi` rows).
Bytes are identical on every row: none of this touches the wire.

```
node bench/run.mjs --compare bench/.builds/R3-base bench/.builds/R3-S5 --samples 10 --json bench/results/r3-full-base-vs-S5.json
```

## Where the time was

`node bench_encode.js` (root of the repo: 100 ticks, each adding 50 players ×
73 tracked instances, then `encode()`) spent its time on the mutation side, not
in the encoder, and the cost structure was inherited from 5.x unchanged:

| phase, ms per tick (3 650 new instances) | 5.0.32 | 6.0 before | 6.0 now |
| --- | --- | --- | --- |
| construct (`new` + setters, detached) | 2.69 | 2.41 | 1.52–1.73 |
| attach (`players.set` → `setParent` → `Root.add`) | 2.93 | 2.50 | 0.86–1.09 |
| encode | 0.81 | 0.83 | 0.77–0.93 |
| `discardChanges` | 0.07 | 0.09 | 0.09 |
| **`bench_encode.js` total, ms** | 897–923 | 835–865 | **546–570** |
| full-state bytes | 8 884 124 | 5 458 157 | 5 458 157 |

Three `Object.defineProperty` lines were 22.4 % of the process (line-level CPU
ticks): `$refId` in `Root.add` (13.2 % — the class declared the field, so the
call was a *reconfigure* of an existing enumerable property, the slowest path,
~380 ns), `$changes` in `Schema.initialize` (6.4 %) and in the `ArraySchema`
constructor (2.8 %). The decoder paid the same two calls per decoded instance.

## What changed

- **`refId` lives on the ChangeTree** (`tree.refId`, also on
  `UntrackedChangeTree`). `Root.add` / `ReferenceTracker.addRef` are plain
  stores; `recycle()` resets it; upgrading a decoder stub to a real tree
  (`ensureTracked`) carries it across.
- **The tree lives in a private slot** stamped through a return-override class
  (`TreeStamp`, `src/encoder/ChangeTree.ts`) — as invisible to
  `deepStrictEqual` / `util.inspect` as the non-enumerable property was, written
  by a plain store. One stamper per process (published under a `Symbol.for`
  key) so two bundled copies of the library share the private name.
  `instance[$changes]` / `instance[$refId]` remain as non-enumerable prototype
  accessors (`defineRefAccessors`) for everything outside the hot paths.
- **`ArraySchema` keeps an own `$changes` property.** Its public identity is a
  Proxy; V8 stores a Proxy's private fields in a side dictionary (~137 B per
  array: `encoder/memory-footprint` +6.3 %) and stamping one is slower than the
  `defineProperty` it would replace. Readers branch on `Array.isArray`, which
  sees through the Proxy.
- `enterFrame` asks only collections for `$childType` (on a Schema tree the
  probe is a guaranteed megamorphic miss: 8.7 % of a bulk-ADD encode) and reads
  `tree.values`; `addParent` / `removeParent` compare identities before trees;
  the attach walk reads Schema children from `tree.values`, not the getter.

## What the numbers say

| scenario | unit | before | after | Δ |
| --- | --- | --- | --- | --- |
| mutations/tree-build/construct | ms/op | 2.284 | 1.526 | −33.2 % |
| mutations/tree-build/attach-fresh (build + attach) | ms/op | 6.327 | 3.699 | −41.5 % |
| mutations/tree-build/attach-steady | ms/op | 6.682 | 4.021 | −39.8 % |
| encoder/construct | µs/entity | 5.726 | 3.298 | −42.4 % |
| encoder/deep-nested | ms/tick | 7.299 | 4.520 | −38.1 % |
| encoder/map-churn (4 variants) | ms/cycle | | | −29…−32 % |
| encoder/entity-churn | ms/cycle | 0.0829 | 0.0579 | −30.2 % |
| mutations/map-ops/add-delete-{str,num} | µs/op | 383 / 364 | 255 / 231 | −33 / −37 % |
| mutations/array-refs/push-pop-100 | ms/tick | 0.00216 | 0.00141 | −34.8 % |
| encoder/bulk-add/{patch,full} | ms/op | 0.713 / 8.13 | 0.663 / 7.47 | −7 / −8 % |
| encoder/encode-all, matrix/full-* | | | | −13…−14 % |
| decoder/map-bootstrap/players-{num,str}-1000 | ms/op | 1.829 / 2.004 | 0.942 / 1.118 | −48 / −44 % |
| decoder/bootstrap | ms/op | 3.376 | 2.163 | −35.9 % |
| decoder/bulk-add/bootstrap | ms/op | 45.86 | 29.34 | −36.0 % |
| realworld/big-state/decode-{10k,20k} | ms/op | 19.87 / 40.76 | 13.46 / 26.98 | −32 / −34 % |
| decoder/map-churn/{str,num} | ms/frame | 0.0242 / 0.0206 | 0.0204 / 0.0165 | −16 / −20 % |
| stateview/views/{v1,v10,v50,v100heavy} | ms/tick | | | −8…−16 % |
| realworld/entities-aoi (4 of 5 variants) | ms/tick | | | −4…−7 % |
| encoder/memory-footprint | KB | 2 578 | 2 583 | +0.2 % |

`encoder/bulk-add/patch` also closes a gap the new isolated scenario exposed:
against 5.0.31 the 6.0 encode of a bulk-ADD tick was +10.6 % before this change.

Full sweep: 65 rows faster, every steady-state decode / callbacks / resync /
view-churn row within ±2 % or not significant. What is left above 2 %:

- `callbacks/map-churn` reads +12…+20 % in the default window (50 warm-up +
  1 000 measured frames) and **−9…−11.5 % (p < .001) with `--iters 3000`**; a
  plain 12 000-frame loop agrees (0.0204–0.0219 vs 0.0240–0.0242 ms/frame). The
  default window measures JIT tier-up of this scenario's re-`listen` path, not
  its steady state. A/A noise floor on the default window: ±6.6 %.
- `mutations/map-ops/has-str` +8.9 % (A/A −0.7 %). `MapSchema.has` is
  byte-identical in both bundles (`return this.$items.has(key)`) and
  `has-num` / `get-str` on the same map are flat: a heap-placement effect on
  the native string-keyed lookup, not code.
- `realworld/large-patch/enc-5k-nested` flips sign between runs (−2.0 %, −1.8 %,
  +2.4 %); `enc-5k-quantized` measured +2.6 % once and +0.6 % (p = .37) at 20
  samples.

## Lessons

- **Inline-cache feedback belongs to the function literal.** The first version
  routed every tree read in the library through one reader (`TreeStamp.of`).
  Setters and the encoder feed it every shape in the process, so it is
  megamorphic at *every* caller — including sites that used to own a cheap
  polymorphic `ref[$changes]` cache. Encoder sites were already megamorphic and
  stayed neutral, which hid it; the decoder's per-chunk read was not, and
  `decoder/tick` went +14…+16 %, `callbacks/*` +5…+11 %, `entities-aoi nested`
  +5.5 %. A textually separate static with the same body (`ofDecoded`, `ofView`)
  restored all three. Closures created from one literal do not help: they share
  a feedback cell.
- A prototype getter over the slot costs +10…+20 ns on a polymorphic site, and
  `ref[$refId]` implemented through `this[$changes]` pays two. The rows that
  regressed in the first sweep (`stateview/view-churn` +28 %, `decoder/resync`
  +9.5 %) were exactly the modules still reading through the accessors.
- A `#field in obj` brand check measured ~20 ns in situ (9 % of a bulk-ADD
  encode). The value reader is `try { o.#tree } catch { o[$changes] }` behind a
  `typeof` guard: nothing throws in practice.
- Rejected: one shared descriptor object for `defineProperty($changes)` — +3.5…
  +3.8 %; V8 handles the fresh literal better than store / call / reset.
- A cold-memory micro-benchmark showed private slots reading 2× slower than the
  symbol property at 300 000 live objects; object layout is identical
  (`%DebugPrint`: both in-object) and the gap vanishes at cache-resident sizes —
  heap placement in the synthetic loop, not a property of private fields.
- Not caused by this change, found while testing it: driving copy A's classes
  with copy B's `Encoder` / `Decoder` (two bundled copies in one process) does
  not round-trip on the baseline build either (`instanceof MapSchema` fails in
  the decoder; the encoder path produces a wrong result).

Open leads from the profiles: `$root.refs.get(refId)` is 22…27 % of a steady
decode tick (a dense array indexed by refId beside the Map); `Root.add` is ~12 %
of attach / delete churn (`changeTrees` / `refCount` are plain objects with
integer keys and `delete`); a `parentTree` field on the ChangeTree would remove
about ten tree loads per StateView add / remove; GC is ~15 % of construction.

# Reference tables — A/B (`RefTable` for `decoder.root.refs` and `encoder.root.changeTrees`)

Same machine and protocol as the previous section. A = the tree after
"Construction and attach" (`bench/.builds/R3-S6`), B = this change
(`bench/.builds/R4-G` for the full sweep; `R4-H` adds the append fast path and
was re-measured on the rows it affects). Bytes identical on every row.

```
node bench/run.mjs --compare bench/.builds/R3-S6 bench/.builds/R4-G --samples 10 --json bench/results/r4-full-S6-vs-R4G.json
```

## Where the time was

- **Decoder**: `const ref = $root.refs.get(refId)` — a `Map` hash probe per
  chunk and per ref-valued slot — was 22…27 % of a steady decode tick
  (line-level ticks, `decoder/tick`).
- **Encoder**: `Root.changeTrees` was a plain object indexed by refId. In an
  attach / detach loop `this.changeTrees[refId] = tree` was 10.6 % and
  `delete this.changeTrees[refId]` 3.8 %: growth plus `delete` on integer keys.
  At 2 000 pushes + 2 000 pops per tick it fell off a dictionary-mode cliff.

Both are now a `RefTable` (`src/RefTable.ts`): page 0 is a growable packed
array behind a direct field, further pages are fixed (4 096 entries) and
released when their last entry goes, except the frontier page.

## What the numbers say

| scenario | unit | before | after | Δ |
| --- | --- | --- | --- | --- |
| decoder/tick | ms/frame | 0.0954 | 0.0666 | −30.2 % |
| realworld/large-patch/dec-5k{,-typed} | ms/tick | 0.581 / 0.548 | 0.516 / 0.494 | −11 / −10 % |
| realworld/small-patch/dec-one-entity | µs/tick | 0.1318 | 0.1118 | −15.2 % |
| realworld/inventory-rpg/dec | ms/tick | 0.0335 | 0.0285 | −15.0 % |
| decoder/deep-nested | ms/frame | 0.00696 | 0.00546 | −21.6 % |
| callbacks/density/{none,sparse1pct,dense} | ms/frame | | | −19 / −21 / −15 % |
| callbacks/strategies/{raw,state,legacy} | ms/frame | | | −27 / −16 / −12 % |
| decoder/bulk-add/{bootstrap,turnover} | ms/op | 28.37 / 6.19 | 24.30 / 5.34 | −14 / −14 % |
| realworld/big-state/decode-20k | ms/op | 27.24 | 24.72 | −9.2 % |
| encoder/map-churn (4 variants) | ms/cycle | | | −24…−31 % |
| encoder/entity-churn | ms/cycle | 0.0576 | 0.0448 | −22.2 % |
| mutations/map-ops/add-delete-{str,num} | µs/op | 260 / 228 | 183 / 151 | −30 / −34 % |
| mutations/array-refs/push-pop-2000 | ms/tick | 0.1708 | 0.0015 | −99.1 % |
| stateview/array-reindex/pop-1000 | ms/tick | 0.0506 | 0.0116 | −77.0 % |
| mutations/array-refs/push-pop-100 | ms/tick | 0.00143 | 0.00111 | −22.3 % |
| mutations/tree-build/attach-steady | ms/op | 3.844 | 3.624 | −5.7 % |
| realworld/turn-based/broadcast-1000 | µs/tick | 267.1 | 248.0 | −7.2 % |
| encoder/memory-footprint | KB | 2 583 | 2 590 | +0.3 % |

Full sweep: 49 rows faster, 4 flagged. `realworld/big-state/handshake`
(+5.4 %) and `encoder/matrix/patch10pct-2000` (+2.6 %) read +0.9 % and −1.1 %
(both n.s.) on `R4-H`. `encoder/construct` reads +4…+6 % in its default window
(2 warm-up runs + 35 measured), +2.7 % (p = .09) with `--iters 40`, and a plain
60-run loop has `R4-H` level with or ahead of the build without the change
(3.49–3.50 vs 3.50–3.59 µs/entity): tier-up of new code in a short window.
`node bench_encode.js` is unchanged (536–580 ms): it neither decodes nor churns.

## Lessons (three layouts were measured before this one held)

- **Never drop the frontier page.** RefIds only grow, so the highest page is
  the one that receives the next entries. Releasing it when it emptied made a
  push-100 / pop-100 tick re-allocate a page every tick: `array-refs/push-pop-100`
  +136 %, GC ×5. It is released when the table grows past it.
- **1 024-entry pages behind the directory**: `turn-based/broadcast-1000`
  (1 000 small decoders in one process — every lookup is cold) +10…+12 % from
  the extra dependent load, and `mmo-shards/enc-c500` +4…+6 % because a
  1 500-refId room falls outside page 0 (the per-view drain does a few
  `changeTrees` lookups per client per tick, and the old dense object was a
  single load there).
- **4 096-entry pre-allocated pages**: fixes `enc-c500`, but every new Encoder /
  Decoder pays a 32 KB page — `big-state/handshake` +11.5 %, `broadcast-1000`
  +10.8 %.
- **Growable page 0 + fixed pages after it** serves both: a 12-ref turn-based
  decoder owns a 12-slot array, a 1 500-ref room stays on the one-load path, and
  an append (`i === page.length`) is a single `push`.
- The churn scenarios (`decoder/churn`, `decoder/map-churn`, `callbacks/map-churn`,
  `callbacks/add-remove-churn`) had `warmup: 50` on 20–45 µs frames; the decode
  path needs ~1 500 frames to reach the optimizing tier, so their window
  measured tier-up. A build that is 6–11 % faster at steady state read +12…+20 %
  slower, twice. They now warm up for 2 000 frames (A/A −1.6 %, n.s.); their
  absolute numbers are ~40 % lower than in the sections above and not comparable
  with them. Rule of thumb that came out of it: on a µs-scale scenario, run A/A
  for the noise floor and `--iters ×3` before believing a regression.

Not changed, worth a decision: `Root.refCount` (encoder) keeps a `0` entry for
every refId ever removed — tests assert that `0` — so it grows without bound in
a long-lived room with churn. Moving the "re-stage on re-add" signal it carries
to the existing `needsRestage` flag would let the entry be deleted on removal.

## Decoder against 5.x (5.0.32 vs `R4-H` / `R4-I`, 10 samples)

Every decode path is faster than 5.0.32 (bytes differ by design):

| group | Δ vs 5.0.32 |
| --- | --- |
| decoder/tick | −91 % |
| decoder/deep-nested | −85 % |
| decoder/resync/{full,churn} | −75 / −72 % |
| decoder/bootstrap, bulk-add/{bootstrap,turnover} | −68, −65 / −53 % |
| decoder/churn, map-churn/{str,num} | −51, −49 / −52 % |
| decoder/map-bootstrap (4 variants), map-replace/{str,num} | −30…−63, −21 / −49 % |
| callbacks/density, callbacks/strategies | −77…−85, −75…−87 % |
| callbacks/add-remove-churn, callbacks/map-churn | −41, −34…−35 % |
| realworld/large-patch/dec-5k{,-typed}, small-patch/dec-one-entity | −86 / −87, −77 % |
| realworld/big-state/decode-{10k,20k,10k-callbacks} | −70 / −69 / −52 % |
| realworld/entities-aoi-decode (3 variants) | −28…−54 % |
| realworld/inventory-rpg, lobby-chat (dec / callbacks) | −55 / −39, −29 / −21 % |
| realworld/turn-based/broadcast-{100,1000}, mmo-shards/e2e-c20, e2e/room-tick | −75 / −85, −58, −36 % |

Reading a decoded `ArraySchema` (`decoder/array-read`, 2 000 elements): `index`
−98 %, `length+at` −96 %, `map` −18 %, `spread` −7 %, `forEach` / `filter`
within ±1 %. Two rows are slower than 5.x, both a consequence of `ArraySchema`
being an `Array` subclass instead of wrapping a plain internal array:

- `for-of` was +84 % (and allocating: a `{ value, done }` per element, GC 0 →
  21 ms). The values iterator now updates ONE result object in place: −27 %
  (−20 % on the encoder side, `spread` −6 %, no GC) and +38 % against 5.x
  (7.2 vs 5.2 µs). The native array iterator is no alternative: on a subclass
  instance it measures 15.9 µs against 10.0 µs for the hand-written one, and
  only a plain array's gets inlined into an index loop (5.4 µs). Code that
  holds a result across `next()` calls sees it change; `keys()` / `entries()`
  still hand out fresh results.
- `indexOf-last` +113 % (1.7 vs 0.8 µs): 5.x ran the native `indexOf` on its
  plain internal array; on a subclass receiver the native builtin is 3–4×
  slower than the typed index loop used here. Closing it needs the
  internal-array storage model.

# Per-instance storage — A/B (`refCount`, `$values`, `keyByIndex`, array trees, `parentTree`)

Same machine and protocol. A = the tree after "Reference tables" plus the
iterator change (`bench/.builds/R4-I`), B = `bench/.builds/R6-E`. Bytes identical
on every row.

```
node bench/run.mjs --compare bench/.builds/R4-I bench/.builds/R6-E --samples 10 --json bench/results/r6-full-R4I-vs-R6E.json
```

Full sweep: **67 rows faster, none slower**, no byte mismatch. `node bench_encode.js`:
484–497 ms (546–570 before this section, 835–865 at the start of the work,
892 on 5.0.32), make-changes 3.4–3.6 ms / tick, encode 1.29–1.33 ms / tick.

## What changed

- **`Root.refCount` no longer leaks.** It was a plain object that kept a `0` for
  every refId ever removed. It is a `RefTable` holding attached trees only;
  `remove()` deletes the entry and arms the tree's `needsRestage` flag, which
  now carries "re-stage on re-add" for removal as it did for `recycle()`.
  Timing neutral; heap growth over a churn run: `encoder/map-churn` 2 175 →
  213 KB, `encoder/entity-churn` 3 120 → 180 KB, `tree-build/attach-steady`
  6 007 → 108 KB.
- **`$values` is an exact-size packed array**: a `.slice()` of a per-class
  template (`EncodeDescriptor.valuesTemplate`). `[]` grows to a 17-slot backing
  store on the first index store — 192 B for a two-field instance against 72 B.
- **`MapSchema.keyByIndex` is a `RefTable`** (wire indexes are handed out in
  order and never recycled).
- **An ArraySchema's tree is stamped on the raw target only** (113 ns; the
  `defineProperty` it replaces was 287 ns and the hottest line of entity
  construction, 9.1 %). Readers that can meet an array branch on
  `Array.isArray` and hop through `$proxyTarget`.
- **`ChangeTree.parentTree` replaces the `parentRef` slot** (`parentRef` is a
  getter over it) and `setParent` / `addParent` take the parent's tree from the
  caller, who always holds it: nothing derives a parent tree from a ref any more
  (it was three megamorphic loads per attached instance, plus every StateView
  add / remove / visibility check).

## What the numbers say

| scenario | unit | before | after | Δ |
| --- | --- | --- | --- | --- |
| encoder/construct | µs/entity | 3.556 | 2.569 | −27.8 % |
| mutations/tree-build/attach-{fresh,steady} | ms/op | 3.476 / 3.693 | 3.003 / 3.095 | −14 / −16 % |
| encoder/deep-nested | ms/tick | 4.864 | 4.194 | −13.8 % |
| encoder/memory-footprint | KB | 2 586 | 2 326 | −10.0 % |
| realworld/big-state/decode-{10k,20k} | ms/op | 11.89 / 25.28 | 9.39 / 23.14 | −21 / −8.5 % |
| decoder/bootstrap | ms/op | 2.230 | 1.991 | −10.7 % |
| decoder/map-bootstrap/scores-{num,str}-10000 | ms/op | 1.561 / 2.898 | 1.215 / 2.447 | −22 / −16 % |
| decoder/map-replace/{str,num}-100pct | ms/frame | 0.0431 / 0.0285 | 0.0335 / 0.0227 | −22 / −20 % |
| encoder/map-replace/num-{100,10}pct | ms/op | | | −13 / −11 % |
| mutations/map-ops get / keys / for-of (num) | µs/op | 11.55 / 1.76 / 8.70 | 8.33 / 1.42 / 7.11 | −28 / −19 / −18 % |
| mutations/map-ops/add-delete-{num,str} | µs/op | 157 / 184 | 143 / 168 | −9 / −9 % |
| mutations/array-iterate forEach / for-of / map / filter | µs/op | 7.17 / 8.18 / 5.65 / 7.43 | 5.76 / 6.84 / 5.03 / 6.68 | −20 / −16 / −11 / −10 % |
| decoder/array-read index / forEach / for-of / length+at | µs/op | 5.83 / 6.68 / 7.93 / 1.09 | 4.81 / 5.60 / 6.77 / 0.94 | −18 / −16 / −15 / −14 % |
| realworld/entities-aoi/n2000-c50-nested | ms/tick | 3.226 | 2.932 | −9.1 % |
| stateview/array-reindex/shift-1000 | ms/tick | 0.01735 | 0.01606 | −7.4 % |
| callbacks/strategies/raw, callbacks/density/sparse1pct | ms/frame | | | −10 / −9 % |

Reading a decoded array against 5.0.32 now: `index` −99 %, `length+at` −96 %,
`map` −26 %, `forEach` −19 %, `spread` −13 %, `filter` −11 %; `for-of` +17.6 %
(it was +84 %), `indexOf-last` +80 % (needs the internal-array storage model).

## Lessons (each of these was found by a sweep and bisected across the frozen per-step builds)

- **Elements kind matters as much as size.** The first pre-sized `$values` was
  `new Array(numFields + 1)`: as small as the final version, but HOLEY, and a
  holey `$values` made every field read 5…10 % slower in tight loops
  (`array-iterate/for-of` +9.7 %, `filter` +6 %). It passed the targeted runs
  (memory, construction, decode) and only showed two steps later, in the full
  sweep. The packed template clone is the same 72 B and reads *faster* than the
  old 17-slot array did.
- **A decoder-built ArraySchema is its own raw target.** Sending the decoder's
  reader through the `Array.isArray` → `$proxyTarget` hop cost `decoder/tick`
  +18 %, `callbacks/density/none` +16 %, `turn-based/broadcast-100` +17 %. The
  decoder reads the slot directly and falls back only for an encoder-built Proxy
  (the initial value of an array field on the state handed to `new Decoder`).
- **Hand the tree down, do not re-derive it.** `parentTree` derived inside
  `addParent` with `refTreeOf(parent)` cost `tree-build/construct` +12.5 % (most
  parents are array Proxies); as an extra field it cost memory +1.1 %. Passed in
  by the caller and stored *instead of* `parentRef`, it costs neither.
- `undefined >>> 12` is `0`: a table keyed by small integers must reject a
  missing key explicitly, or it reads — and deletes — slot 0 (here, the root).
- A generator-backed `forEach` on the table cost `encoder/map-encode-all` ~2 %;
  the hot walk uses plain loops.

Open leads: `MapSchema.set` still does one Map read and two Map writes per ADD
(`indexByKey`, `$items`) — ~10 % of entity construction; GC is ~12 % of it;
`assertInstanceType` runs an `instanceof` per `set` / `push`; `Root.remove` and
StateView allocate a `forEachChild` closure per removed node; the decoder's
`refCount` / `callbacks` are still plain objects with integer keys and `delete`.

# Keyed recorder, and what was measured and left alone in `MapSchema`

Same machine and protocol. A = `bench/.builds/R6-E` ("Per-instance storage"),
B = `bench/.builds/R8-A`. Bytes identical on every row.

```
node bench/run.mjs --compare bench/.builds/R6-E bench/.builds/R8-A --samples 10 --json bench/results/r8-full-R6E-vs-R8A.json
```

## `KeyedRecorder` without a Map

The question was `MapSchema.set`. The profile of a REPLACE-heavy tick (1 000
`scores.set(key, n)` per tick) answered with the recorder instead:
`ops.set(index, next)` in `KeyedRecorder.add` was the hottest line, 22.9 %. The
recorder kept its pending ops in a `Map<wireIndex, op>` that is **cleared every
tick**, and a cleared Map drops its table and re-grows it with rehashing.

The recorder needs two things from that structure: an O(1) merge lookup by wire
index, and iteration in first-record order — that order *is* the wire order, so
the bytes may not change. It is now `order[0 … count)` (first-record order,
never truncated) plus one byte per wire index in lazily allocated pages
(`op + 1`, since `REPLACE` is 0). A reset zeroes the bytes it touched and keeps
the pages; pages that went idle are dropped whenever a new one is needed (wire
indexes only grow); the first page starts at 32 bytes and doubles.

| scenario | unit | before | after | Δ |
| --- | --- | --- | --- | --- |
| mutations/map-ops/set-replace-{str,num} | µs/op | 79.8 / 59.1 | 56.3 / 33.4 | −29 / −43 % |
| encoder/map-replace/num-{10,100}pct | ms/tick | 0.0124 / 0.0961 | 0.0071 / 0.0580 | −43 / −40 % |
| encoder/map-replace/str-{10,100}pct | ms/tick | 0.0205 / 0.2207 | 0.0163 / 0.1584 | −21 / −28 % |
| encoder/map-churn (4 variants), entity-churn | ms/cycle | | | −4…−8 % |
| GC time, encoder/map-replace/num-100pct | ms | 105 | 0.2 | |

A micro-benchmark of the two structures (add + emit + reset, ns per recorded
op): 1 000 dirty indexes 31.4 → 6.6; 10 dirty 66.7 → 28.3; 10 dirty at index
500 000 equal (54.7 vs 64.5).

The first version allocated a full 4 KB page on a collection's first recorded
op. A state made of many small maps paid for it: `tree-build/attach-steady`
+4.4 %, `encoder/deep-nested` +5.4 % in the sweep; both within noise with the
growing first page. Same lesson as `RefTable`: the first page follows the
content, only the later ones are fixed-size.

## Measured and declined: collapsing `$items` and `indexByKey`

With the recorder out of the way, `set` on an existing key is three string-hash
operations on the same key — `indexByKey.get` 28 %, `$items.get` 14 %,
`$items.set` 13 % of the tick. `$items` (key → value) and `indexByKey`
(key → wire index) cover the same key set, so one Map plus values addressed by
index would do. Per entry, 1 000-entry string-keyed map:

| | two Maps (kept) | both Maps + value table | one Map + value table |
| --- | --- | --- | --- |
| REPLACE | 30.9 ns | 25.1 (−19 %) | 13.8 (−55 %) |
| `get` | 10.6 ns | ≈ | 14.6 (+38 %) |
| `forEach` | 6.0 ns | ≈ | 8.7 (+45 %) |
| `for…of` | 7.1 ns | ≈ | 19.1 hand-written iterator (+70 %); 36.3 generator |

Once the values leave the Map, V8's native Map iterator cannot serve
`for…of` / `entries()` any more, and `get` pays a second dependent load.
Iterating the index table instead of a Map is worse: it is proportional to
slots, not to live entries, and a few long-lived entries scattered over many
pages is exactly what a long-running room produces. Game loops read and
iterate maps far more often than they replace primitives in them; not done.
For whoever reopens it: membership is defined by `$items` alone (after
`delete`, the index mappings linger until `$onEncodeEnd` so a same-tick re-set
keeps its wire index), and a re-set key moves to the end of iteration order.

## Two small ones

- `assertInstanceType` compares `value.constructor === type` before falling
  back to `instanceof` (a prototype-chain walk on every ref `set` / `push`).
- `Root.remove` walks the detached node's children through
  `forEachChildWithCtx` with a per-depth pooled context instead of allocating a
  closure per removed node.

Together: `tree-build/attach-{fresh,steady}` −2.7 / −2.9 % (p < .05),
`tree-build/construct` −5.8 % (p = .06), `array-refs/push-pop-2000` −11 %.

## Sweep

Full sweep (`R6-E` → `R8-A`): 20 rows faster, no byte mismatch. Five rows
flagged; `decoder/array-read/for-of` (+7.1 %), `small-patch/five-entities`
(+3.8 %) and `entities-aoi-decode/n10000-c1` (+2.4 %) re-measure at +0.5 %,
−0.1 % and −0.3 % (all n.s.) at 14 samples. `mutations/map-ops/has-str` (+14 %) and
`forEach-num` (+5 %) do reproduce, with a tight A/A (−2.0 % / −2.9 %, n.s.) —
on code that is byte-identical in both bundles (`has(key) { return
this.$items.has(key); }`), and only from the last step on, which changed
`assertInstanceType` and `Root.remove`: neither runs in a `has()` loop. A 13 ns
native string-keyed `Map.has` is sensitive to where the setup happened to place
the table and the key strings; the same row read +8.9 % on identical code in
"Construction and attach" and −4 % in between. Reported, not chased.

# Harness round (docs/perf/leads/10, 2026-09-22)

Numbers in older sections were taken with the scenario warm-up counts only.
From here on `run.mjs` enforces a 100 ms minimum warm-up per sample
(`--min-warmup-ms 0` reproduces the old windows), randomises heap layout on
the `map-ops` read rows, and runs `encoder/construct` with
`--no-allocation-site-pretenuring` (pretenuring was a per-process lottery worth
+30 % on that row). A/A `R8-A` vs `R8-A`, 8 samples, 18 rows (map-ops,
construct, array-read/for-of, views): one flag (`views/v100heavy` −1.0 %,
p = .014), within the 5 % expected. `forEach-num` `R6-E → R8-A`: +7.3 % / +6.4 %
(p < .001) under the old harness, −2.1 % / +0.9 % (n.s.) now.

## Decoder `refCount` / `callbacks` on `RefTable` (LEADS 02, `L02-base` → `L02-both`, 10 samples)

As integer-keyed plain objects, the `refCount` store / `delete` / decrement cost
8–17 % of the decoder churn loops (line ticks), and the `callbacks` store and
`delete` cost another 1–3 %. Both are now `RefTable`s, with the same `undefined`
(not tracked) versus `0` (pending GC) distinction.

| row | Δ |
| --- | --- |
| decoder/churn | −36.8 % |
| decoder/map-churn str / num | −22.7 % / −20.7 % |
| decoder/bulk-add/turnover | −25.6 % |
| callbacks/add-remove-churn | −29.7 % |
| callbacks/map-churn str / num | −35.4 % / −35.1 % |
| decoder/bootstrap | +1.6 % (a second table grown by `push`; accepted) |
| decoder/tick, callbacks/density, callbacks/strategies, realworld decode-10k-callbacks | neutral |

Per-step numbers are in `docs/perf/leads/02-decoder-refcount-callbacks-tables.md`.

# Construction allocations (docs/perf/leads/01, 2026-09-22)

`L01-base` (c8c3bc6) → `L01-s1` → `L01-s2` → `L01-s3`, 10 samples/side, bisect
(each build vs base). Measured before touching anything: an instrumented bundle
found **100 %** of created recorders record on every fixture and in
`bench_encode.js` (50 000 / 50 000 array logs, 5 001 / 5 001 keyed), so the
lead's cheapest candidates (lazy recorder, lazy `keyByIndex`) were dropped
without a build. The published ESM bundle emits native class fields, so every
one of ChangeTree's 28 slots existed from construction: 248 B per tree, 70 % of
a 2-field Schema's 354 retained bytes — the diet is where the memory was.

| step | change |
| --- | --- |
| s1 | `ChangeTree.elements` slot and the dead `ref[$items] ?? ref` reads removed (always the raw target) |
| s2 | `KeyedRecorder`: page 0 a direct field; page directory + epoch array only past 4 096 wire indexes |
| s3 | `ChangeTree`: 6 rare fields (`extraParents`, unreliable recorder + node, `tagBits`, `tagViews`, `subscribedViews`) behind one lazy side object; `metadata` a getter; `paused` a flag bit → 20 slots, 184 B |

| row | unit | base | s1 | s2 | s3 |
| --- | --- | --- | --- | --- | --- |
| encoder/memory-footprint | KB | 2 319 | −1.1 % ✓ | −1.0 % ✓ | **−8.3 % ✓** |
| mutations/tree-build/construct | ms/op | 1.132 | −5.3 % ✓ | −6.6 % ✓ | −4.6 % ✓ |
| mutations/tree-build/attach-fresh | ms/op | 2.548 | −1.6 % | −2.3 % ✓ | −3.9 % ✓ |
| mutations/tree-build/attach-steady | ms/op | 2.822 | −0.6 % | −0.4 % | −2.5 % ✓ |
| encoder/construct | µs/entity | 2.172 | −0.8 % | −1.7 % | +0.6 % ² |
| decoder/bootstrap | ms/op | 1.911 | +0.6 % ² | −1.7 % | +1.7 % ✗ (A/A −0.7 %, p .12) |
| realworld/big-state/encode-10k | ms/op | 3.140 | +0.3 % | −1.0 % | +1.3 % |
| realworld/big-state/encode-20k | ms/op | 6.350 | +0.7 % ✗ | −0.1 % | −0.4 % |
| realworld/big-state/decode-10k | ms/op | 8.670 | −0.7 % | +0.6 % | −0.0 % |
| realworld/big-state/decode-20k | ms/op | 21.43 | +0.8 % | +0.1 % | +0.2 % |

Retained bytes per instance (20 000 kept, `--expose-gc`): Schema with 2 fields
354 → 290, `MapSchema` + 1 entry 1 827 → 1 403, `ArraySchema` + 5 pushes
1 018 → 954, Tree `Player` 1 692 → 1 444. `%DebugPrint`: one map shared by
Schema / Map / Array trees before and after, 0 unused fields, fast properties.
`bench_encode.js` 446 ms (was 484–497), 5 458 157 bytes.

Still open when this was written: the `decoder/bootstrap` flag (at the row's
noise floor; decoder-built instances use `UntrackedChangeTree`, which did not
change) wants the `--iters ×3` re-read; `big-state/decode-10k-callbacks` and
`handshake` could not launch on any side (status 0xC0000142 — the machine ran
out of memory) and the broad `encoder/,decoder/,mutations/,stateview/` compare
and the test suite were not run: the bench job was stopped for memory pressure.

Lesson: check what the *published* build emits before reasoning about a shape
from the TypeScript config — the source comment said the optional fields were
absent until assigned; the bundle had defined all of them at construction.


# LEADS round sweep (2026-09-23): `R8-A` (44f64d2) → `W3` (2ab22f0 code)

Full sweep, 144 units, 10 samples/side, harness from LEADS 10 (warm-up time floor,
layout padding, automatic A/A column). **42 rows faster, 9 slower.**

What landed in between: LEADS 11 (dead code), 10 (harness), 07 (`Schema.initialize`
idempotent), 02 (decoder `refCount` / `callbacks` on `RefTable`), 01 (ChangeTree diet).
`node bench_encode.js`: 484–497 ms → **438 ms**, bytes unchanged (5 458 157).

Bisect of the 9 slower rows (20 samples/side, R8-A → `W1b-preL02` (5eae0e8) → W2 (bb40a07) → W3):

| row | → pre-L02 | → W2 (L02) | → W3 (L01) | A/A |
| --- | --- | --- | --- | --- |
| `decoder/map-bootstrap/players-num-1000` | −1.5 % | **+11.1 % ✗** | +11.9 % ✗ | −0.9 % |
| `decoder/map-bootstrap/players-str-1000` | +2.3 % | **+7.1 % ✗** | +7.7 % ✗ | −0.4 % |
| `callbacks/density/dense` | +0.3 % | **+7.7 % ✗** | +3.8 % | −0.4 % |
| `decoder/map-replace/str-100pct` | +0.3 % | +1.9 % ✗ | +0.6 % | +0.2 % |
| `encoder/map-encode-all/scores-str-10000` | −0.8 % | +0.3 % | +1.5 % ✗ | −0.0 % |
| `decoder/array-read/length+at` | +0.2 % | +0.7 % | +1.4 % ✗ | −0.5 % |
| `e2e/room-tick`, `encoder/map-churn/num-1000`, `stateview/array-reindex/shift-*` | | | noise (≤ ±3.6 %, sign flips) | |

**Real regression: LEADS 02 on decoder bootstrap of maps** (+7…+11 %) and on
`callbacks/density/dense` (+7.7 %). The lead-02 run measured `decoder/bootstrap`
only (+1.6 %). Suspected mechanism: an integer-keyed plain object fills V8 fast
elements on a fresh bootstrap and only degrades after `delete`, which is where
`RefTable` wins. A fix is in progress; see docs/perf/leads/02.

Lesson: a change to a shared decoder table must be measured on every bootstrap
shape (`decoder/bootstrap`, `decoder/map-bootstrap/*`, `callbacks/density/*`),
not only the one the lead names.

## Sweep: leads 09, 06, 08 (W7 → R9 = a305e12, 10 samples; flagged rows re-run at 20)

Landed in between: LEADS 09 (cross-copy interop), 06 (MapSchema wire-index
recycling), 08 (hand-off re-encode of a decoded state). Bytes of `bench_encode.js`
unchanged (5 458 157). `encoder/map-churn` bytes −4.5…−8.6 %, time −5…−6 %.

| row | W7 → R9 | W7 → L09 | W7 → L06 | L09 → L08 |
| --- | --- | --- | --- | --- |
| `realworld/mmo-shards/enc-c100` | +4.8 % ✗ | +2.7 % | **+8.4 % ✗** | +3.9 % |
| `realworld/mmo-shards/enc-c500` | +12.8 % ✗ | +2.9 % | **+6.0 % ✗** | −3.6 % |
| `realworld/large-patch/enc-5k` | −0.4 % | −0.3 % | +0.4 % | +1.9 % (A/A −0.6 %) |
| `callbacks/density/none` | +1.4 % | −1.6 % | +1.3 % | −1.4 % |

**The real one: LEADS 06 on many-view ticks.** `Root.pendingViewChanges()` walked
every active view once per tick in which a map freed an index (6.2 % self time at
500 views). The fix (`e2750cb`) walks only the views listed when they created their
first `changes` entry (`StateView.entriesOf`). After it, against W7: enc-c100
+1.7 % (p .16), enc-c500 +2.7 % (p .54); against R9: −3.1 % / −7.5 %.
