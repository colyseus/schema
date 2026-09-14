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
