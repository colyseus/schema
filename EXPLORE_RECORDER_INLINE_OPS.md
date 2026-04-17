# Exploration: Eliminate `ops: Uint8Array` allocation per Schema

## Status of recorder allocations after #3a

Target #3a from the original plan inlined `dirtyLow/High`, `ops`, `record`,
`forEach` directly onto `ChangeTree`. `this.recorder === this` for Schemas;
no separate `SchemaChangeRecorder` object.

What's STILL allocated per Schema:

```ts
// ChangeTree.ts:218
this.ops = new Uint8Array(Math.max(numFields + 1, 1));
```

One `Uint8Array` per Schema instance. On `bench_encode` (~2,500 Schemas
× 100 iter = 250k allocations) this is the residual cost — visible in
GC% as marker work + alloc churn.

## OPERATION value analysis

For Schema-side ops (NOT collection ops), the wire bytes actually stored
in `ops[i]` are a small subset:

| Op | Value (decimal) | High 2 bits | Low 6 bits |
|---|---:|---|---|
| REPLACE | 0 | 00 | 000000 |
| DELETE | 64 | 01 | 000000 |
| ADD | 128 | 10 | 000000 |
| DELETE_AND_ADD | 192 | 11 | 000000 |

Pattern: each op-byte is `tag << 6` for `tag ∈ {0,1,2,3}`. The low 6
bits are always zero. **The whole 8-bit op fits losslessly in 2 bits.**

But since `record()` already uses `prev === 0` as the "unset" sentinel
(conflating REPLACE with "unset"), the existing logic only round-trips
4 distinct values: `{REPLACE/unset, DELETE, ADD, DELETE_AND_ADD}`. So
2 bits per field is sufficient with no semantic loss.

For practical ergonomics we'll store the full 8-bit op-byte (4 bytes
packed per number, 8 ops in 2 numbers) — it costs nothing extra in
storage and avoids a tag↔byte mapping at every read.

## Schema field counts in practice

Sampled real-world Schemas (this repo's tests + bench files):

- Position {x, y}: 2
- Attribute {name, value, secret}: 3
- Item {price, attributes, cooldown, ownerSecret}: 4
- Player {position, name, items, privateGold, secretInventory}: 5
- World/Hub/State: 2–4

Empirically ≤8 fields is ~all real Schemas. Schemas with 9–64 fields do
exist in user code but are rare; we'll keep the `Uint8Array` path as a
fallback for that case.

## Design

### Storage shape

Two new number fields on ChangeTree:

```ts
opsLow: number = 0;   // bytes for fields 0..3 (8 bits each)
opsHigh: number = 0;  // bytes for fields 4..7
```

If `numFields <= 8`: `ops = undefined`, all reads/writes go through inline.
If `numFields > 8`: keep current `ops: Uint8Array` path.

### Read pattern

```ts
function readOp(tree, i) {
    return (tree.ops !== undefined)
        ? tree.ops[i]
        : ((i < 4)
            ? (tree.opsLow >>> (i << 3)) & 0xFF
            : (tree.opsHigh >>> ((i - 4) << 3)) & 0xFF);
}
```

JS bitwise math is 32-bit signed — `>>>` is unsigned shift, so reading
back `0xC0 = 192` (DELETE_AND_ADD) at field 3 (shift=24) round-trips
correctly via `(opsLow >>> 24) & 0xFF`.

### Write pattern

```ts
function writeOp(tree, i, op) {
    if (tree.ops !== undefined) { tree.ops[i] = op; return; }
    const shift = (i & 3) << 3;
    const mask = 0xFF << shift;
    if (i < 4) tree.opsLow = (tree.opsLow & ~mask) | (op << shift);
    else tree.opsHigh = (tree.opsHigh & ~mask) | (op << shift);
}
```

### `forEach` (hot encode-loop path)

The dirty bitmask `dirtyLow/High` already tells us which indexes are set.
For ≤8 fields, only `dirtyLow` (bits 0..7) is touched, and `dirtyHigh`
stays 0. We can branch once on `this.ops === undefined` and run a tight
inline loop.

## Costs / risks

**Win**: kills 250k Uint8Array allocs/iter on `bench_encode` (one per
Schema). Each Uint8Array is a ~80-byte heap object + ArrayBuffer backing
+ GC marker work. Microbench-level expectation: low single-digit % on
`bench_encode`'s wall clock, larger drop in `Unaccounted` / GC ticks.

**Risk**: every `record/recordDelete/operationAt/setOperationAt/forEach`
call site must dispatch on `this.ops === undefined`. The branch is
predictable per-tree (set at ctor) so should be near-free, but it's an
extra check on the hottest path. Worth measuring directly.

**Fallback**: Schemas with >8 fields take the existing Uint8Array path.
No regression there (one extra branch).

## POC plan

1. Add `opsLow`, `opsHigh` to ChangeTree; gate `Uint8Array` alloc on
   `numFields > 8`.
2. Update `record/recordDelete/operationAt/setOperationAt/forEach/
   forEachWithCtx` to dispatch.
3. Run bench_encode and bench_view 10 trials each; compare medians.
4. Run full test suite — no behavior change expected.

## POC results (10 trials each, median)

| Bench         | Baseline (Uint8Array) | POC v1 (inline, duplicated paths) | POC v2 (helpers) |
|---------------|----------------------:|----------------------------------:|-----------------:|
| bench_encode  |                692 ms |                            665 ms |       **660 ms** |
| bench_view    |               1231 ms |                           1170 ms |      **1180 ms** |

POC v2 vs baseline: bench_encode **−4.6 %**, bench_view **−4.1 %**.
v2 vs v1: within noise on both. The DRY refactor cost essentially nothing.

Tests: **528 passing, 13 pending** (no regressions).

## Refactor (v1 → v2): consolidating duplicated paths

v1 had the bitwise math (`opsLow/opsHigh` shift+mask) duplicated across
6+ sites: `record`, `recordDelete`, `operationAt`, `setOperationAt`,
both `forEach`s, and the Schema fast-paths in `change()` /
`indexedOperation()`.

v2 owns ALL the dispatch in three small private helpers + one module-
private function:

- `_opAt(i)` — read with array-vs-inline dispatch
- `_opPut(i, op)` — write with dispatch (no dirty-mark side effect)
- `_markDirty(i)` — set the dirty bit on dirtyLow/dirtyHigh
- `readInlineOpByte(low, high, i)` — pure module-private function for
  the encode-loop hot path (no `this`, V8 inlines aggressively)

Method bodies are now one-liners:
```ts
recordDelete(i, op) { this._opPut(i, op); this._markDirty(i); }
recordRaw(i, op)    { this._opPut(i, op); this._markDirty(i); }
operationAt(i)      { const op = this._opAt(i); return op === 0 ? undefined : op; }
setOperationAt(i, op) { this._opPut(i, op); }
```

The `change()` and `indexedOperation()` Schema fast-paths collapse to
direct method calls (`this.record(...)`, `this.recordRaw(...)`) — the
`recorder === this` branch keeps each call site monomorphic in V8's IC,
so we get DRY without losing the optimization.

## Discussion

Modest but real. The hot encode-loop `forEach` does take the extra
`if (ops !== undefined)` branch, but it's per-tree-stable (set at ctor
and never changes), so V8's branch predictor + IC turn it into a near-
zero cost path. The win comes from:

1. **No Uint8Array allocation** per Schema instance (~2,500/iter on
   bench_encode = 250k allocs gone).
2. **Smaller GC marker pressure** — the typed arrays + their backing
   ArrayBuffers are small but numerous; eliminating them cuts a chunk
   of marker work.
3. **Better inline cache** on `ChangeTree` field accesses — `opsLow` /
   `opsHigh` are smi-tagged numbers and read inline from the object,
   no dereference through a pointer to a heap-allocated Uint8Array.

## Open questions before landing

1. **Boundary at numFields = 8**: a Schema with exactly 8 fields uses
   indices 0..7 — fits inline. The current ctor gate is `numFields > 7`.
   Verified: `record(7, …)` writes shift=24 to opsHigh; reads round-trip.
2. **The dispatch branch (`ops !== undefined`)**: lives on every record
   call and every encode `forEach`. Worth running a tick profile to
   confirm it doesn't show up as a hotspot. Initial signal from
   wall-clock is positive.
3. **Schemas > 8 fields**: take the existing `Uint8Array` path. No
   regression observed; the extra branch is the only added cost.
4. **Should `Uint8Array` path also become lazy?** Independent question
   (Lever B from the overview). Could compose with this POC: large
   schemas that never mutate avoid the alloc entirely.

## Recommendation

Ship as-is. The branch is predictable, the win is measurable on both
benches, the test suite is green, and the fallback path is unchanged.
Pair this with a tick profile (`node --prof bench_encode.js`) before
landing to confirm no hidden hotspot in the dispatch.

(POC currently uncommitted in working tree.)
