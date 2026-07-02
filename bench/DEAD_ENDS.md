# Dead-end registry

Optimization directions that were tried and measurably failed. **Check this
list (exact AND adjacent mechanism) before implementing any candidate.**
Failed candidates from the current loop get appended with measured Δ/p.

## Encoder

- **Per-class encoder codegen** (Option A and C) — measured <5% perTick; not worth the complexity.
- **TextEncoder.encodeInto for strings** — msgpackr-style speculative write loses to two-pass utf8Length+utf8Write for the short strings (player names, map keys) that dominate Colyseus workloads.
- **SoA CollectionChangeRecorder** — −21% on collection-hot benches but +3% regression on Schema-hot paths from hidden-class bloat. Don't add fields to `ChangeTree`.
- **Root.refCount → Uint32Array** — refCount isn't a bottleneck; ±1% doesn't justify `_refCountInit` complexity.
- **MapJournal.indexByKey → Map<string,number>** — −40% churny-key workloads but +7% and 2× GC pressure on stable-key main bench.
- **`$track` call-chain inlining in Schema setters** — null CPU result (all p>0.2); V8 already inlines it.
- **Schema accessor inline-slots (symbol-closure)** — 2.6× slower than current; only STRLIT codegen beats it, too costly.
- **`_markSubtreeVisible` ctx-pool conversion** — make −4.8% but encode +2.6% from cross-function V8 effects.
- **`checkInheritedFlags` fast-path bitmask** — ~1.5% combined win doesn't justify maintenance across 5 setters + subclass copy.
- **`addParent` reorder + closure-free duplicate walk** — make −1.7% but encode +4%; 3rd failed refactor of the setParent recursion.
- **`$refId` pre-install in Schema.initialize** — clean −1.5% but fragile shape invariant across 3 sites. (Sub-finding: `Object.defineProperties` is +11% slower than two `defineProperty` calls.)
- **Iterative `addParentOf`** — +10% to +34% regressions everywhere; V8 inlines the recursion.
- **Pool reset as tree-shakeable free functions** — client bundles already ship the whole encoder; ~93 lines of rounding error.

## Decoder / callbacks

- **Setter bypass in decodeSchemaOperation** (`$values[index]=`) — breaks Reflection-decoded schemas (data descriptors vs accessors). Needs Metadata.addField unification first.
- **decodeValue monomorphization** — V8 still emits 4 versions after removing `ref`; work moves, doesn't disappear.
- **DataChange pooling** — V8 young-gen + stable hidden class beats pool+helper for 7-field literals in hot loops.
- **Per-ref callbacks gate** — callbacks register *during* triggerChanges; "no listener at push time" ≠ "no listener will care". Breaks lazy onAdd registration.
- **Structured callback slots** (C# named-slot port) — extra property hop on the dominant field-listener path; net-zero to worse.
- **triggerChanges per-callback try/finally** — keep `isTriggering` hoisted to one toggle per dispatch pass (per-callback cost ~2% heavy-tick).

- **callbacks registry `{[refId]: …}` → `Map<number, …>`** (2026-07-02) —
  +5.8…+7.1% on callbacks/density+strategies at p<.001. refIds are small
  sequential integers, so the plain object stays in dense ELEMENTS backing —
  faster than Map hashing. Same likely applies to `refCount` and
  `Root.changeTrees` (already a sparse array): keep integer-keyed objects/arrays
  for refId-indexed lookups.

## Constraints (not dead, but load-bearing)

- `$changes` / `$refId` must stay `Object.defineProperty` (non-enumerable) — `deepStrictEqual` and enumeration semantics depend on it.
- StateView `changes` Map insertion order is load-bearing (encoder drain order; decoder depends on it).
- `removeParent()` must return `true` when a parent was found+removed; `addParent()` must update `_parentIndex` on duplicate detection.
- ArraySchema is Proxy-wrapped — compare via `$changes`, not identity.
- Never add `sideEffects: false` to package.json (top-level registerType calls).
