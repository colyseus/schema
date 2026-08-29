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
