# Open leads — v6 execution performance

State as of commit `44f64d2` (2026-09-20), frozen as `bench/.builds/R8-A`.
Everything here came out of the profiling rounds recorded in
`bench/v6-results.md`; each file is one lead, self-contained.

`node bench_encode.js` today: 484–497 ms (v6 at the start of the work:
835–865 ms; 5.0.32: 892 ms), same 5 458 157 bytes.

| # | lead | kind | expected size | risk |
| --- | --- | --- | --- | --- |
| [01](01-construction-allocations.md) | Per-instance allocations / GC in construction | perf + memory | medium (GC ≈ 12 % of construction) | medium |
| [02](02-decoder-refcount-callbacks-tables.md) | Decoder `refCount` / `callbacks` are integer-keyed plain objects | perf + memory | small–medium on churn | low |
| [03](03-stateview-child-walk-closures.md) | Closure per node in StateView / ChangeTree child walks | perf (GC) | small | low |
| [04](04-arrayschema-vs-v5-reads.md) | `ArraySchema` `indexOf` +80 %, `for…of` +18 % against 5.x | perf | medium, only with a storage-model change | parked (doc note added) |
| [05](05-mapschema-set-hashes.md) | `MapSchema.set`: three string hashes per REPLACE | perf | large on writes, **negative on reads** | declined — reference only |
| [06](06-wire-index-recycling.md) | Recycle map / set wire indexes | bytes + memory | small bytes, bounds tables | medium (view drain) |
| [07](07-tree-values-invariant.md) | `tree.values` ↔ `$values` invariant is unenforced | robustness | none (correctness) | low |
| [08](08-refid-collision-on-reencode.md) | Re-encoding a decoded state can collide refIds | correctness | none (bug) | low–medium |
| [09](09-cross-copy-interop.md) | Two bundled library copies do not round-trip | correctness / product | none (decision) | unknown |
| [10](10-bench-harness.md) | Harness: short windows and layout-sensitive rows | tooling | avoids false alarms | low |
| [11](11-dead-code.md) | `ArraySchemaInternal.ts` is imported nowhere | cleanup | — | closed (deleted) |

## How to work a lead (the protocol that held up)

1. Profile first: `node --cpu-prof --cpu-prof-interval 100` on a plain loop of
   the workload, then rank **lines** (`positionTicks`), not just functions.
2. Micro-benchmark the candidate structure in isolation — one variant per
   process/function (a shared call site goes megamorphic and lies).
3. One change = one frozen build: `bash bench/snapshot-build.sh <label>`,
   compare with `node bench/run.mjs --compare bench/.builds/<a> bench/.builds/<b> --samples 10 --filter "<pattern>"`
   (`--filter` takes ONE pattern).
4. Full sweep before calling it done; it found a real regression in every
   round that the targeted runs had missed. It runs ~46 min: launch it detached
   and keep the machine quiet.
5. A regression is bisected across the frozen per-step builds in one run.
   Before believing a µs-scale row: A/A for the noise floor, then `--iters ×3`.
6. Bytes must be identical unless the lead is about the wire.

## Things learned that apply to every lead

- Inline-cache feedback belongs to the function literal: a shared reader is
  megamorphic at every caller. A subsystem with its own small shape set gets
  its own (textually separate) function.
- Elements kind matters as much as size (`new Array(n)` is HOLEY; clone a
  packed template instead).
- First page grows with the content, later pages are fixed; never drop the
  frontier page; `undefined >>> n` is `0`, so reject missing keys explicitly.
- A structure cleared every tick should not be a `Map` (the table is dropped
  and re-grown); a scratch array should not be reset with `length = 0`.
- Hand a value down instead of re-deriving it (parent tree, refId from the
  wire header).
