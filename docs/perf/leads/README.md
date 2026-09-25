# Open leads — v6 execution performance

State as of commit `44f64d2` (2026-09-20), frozen as `bench/.builds/R8-A`.
Everything here came out of the profiling rounds recorded in
`bench/v6-results.md`; each file is one lead, self-contained.

`node bench_encode.js` today: 484–497 ms (v6 at the start of the work:
835–865 ms; 5.0.32: 892 ms), same 5 458 157 bytes.

| # | lead | kind | expected size | risk |
| --- | --- | --- | --- | --- |
| [01](01-construction-allocations.md) | Per-instance allocations / GC in construction — **closed**: ChangeTree 28 → 20 slots (248 → 184 B), lazy `KeyedRecorder` directory, dead `$items` reads | perf + memory | memory-footprint −8.3 %, tree-build −2.5…−6.6 % | landed (pending broad sweep + tests, see lead) |
| [02](02-decoder-refcount-callbacks-tables.md) | Decoder `refCount` / `callbacks` are integer-keyed plain objects | perf + memory | decoder churn −21…−37 %, callbacks churn −30…−44 %; map-bootstrap regression (+8…13 %, a deopted `push`) fixed, bootstrap −3 % | closed (landed: both on `RefTable`; regression fix 2026-09-23) |
| [03](03-stateview-child-walk-closures.md) | Closure per node in StateView / ChangeTree child walks | perf (GC) | add+remove micro −3.8 %, bench rows neutral | closed, not landed (below resolution) |
| [04](04-arrayschema-vs-v5-reads.md) | `ArraySchema` `indexOf` +80 %, `for…of` +18 % against 5.x | perf | medium, only with a storage-model change | closed — accepted trade-off (2026-09-25) |
| [05](05-mapschema-set-hashes.md) | `MapSchema.set`: three string hashes per REPLACE | perf | large on writes, **negative on reads** | declined — reference only |
| [06](06-wire-index-recycling.md) | Recycle map / set wire indexes — **v1 landed**: MapSchema only, no wire / decoder change | bytes + memory | map-churn bytes −4.5…−8.6 %, `nextIndex` bounded by the live size | landed: MapSchema, then Set / Collection (2026-09-25, after the decoder overwrite fix); Stream stays monotonic (H7) |
| [07](07-tree-values-invariant.md) | `tree.values` ↔ `$values` invariant is unenforced — **closed**: idempotent `Schema.initialize`, documented setter / `values` contracts | robustness | none (correctness) | closed |
| [08](08-refid-collision-on-reencode.md) | Re-encoding a decoded state can collide refIds — **closed**: hand-off supported (encoder-owned ids, map `nextIndex` seeded), live relay throws | correctness | hot rows neutral | closed |
| [09](09-cross-copy-interop.md) | Two bundled library copies do not round-trip — **closed**: supported for identical builds (brands, shared inheritance registry, `$collectionCtor`); two-copy test in the suite | correctness / product | hot rows neutral | closed |
| [10](10-bench-harness.md) | Harness: short windows and layout-sensitive rows — **closed**: warm-up time floor, layout padding, A/A column, `--bisect` | tooling | avoids false alarms | low |
| [11](11-dead-code.md) | `ArraySchemaInternal.ts` is imported nowhere | cleanup | — | closed (deleted) |
| [12](12-decoder-gc-metadata-walk.md) | Decoder GC released a collected Schema's children with `for…in` over the metadata — **closed**: walks `$refTypeFieldIndexes` | perf | decoder churn −13…−37 %, callbacks churn −15…−29 %, bootstrap / tick neutral | landed (pending commit) |

## How to work a lead (the protocol that held up)

1. Profile first: `node --cpu-prof --cpu-prof-interval 100` on a plain loop of
   the workload, then rank **lines** (`positionTicks`), not just functions.
2. Micro-benchmark the candidate structure in isolation — one variant per
   process/function (a shared call site goes megamorphic and lies).
3. One change = one frozen build: `bash bench/snapshot-build.sh <label>`,
   compare with `node bench/run.mjs --compare bench/.builds/<a> bench/.builds/<b> --samples 10 --filter "<p1>,<p2>"`
   (comma list; flagged rows get an automatic A/A column).
4. Full sweep before calling it done; it found a real regression in every
   round that the targeted runs had missed. It runs ~46 min: launch it detached
   and keep the machine quiet.
5. A regression is bisected across the frozen per-step builds in one run
   (`run.mjs --bisect <base> <b1> <b2> …`).
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
- Don't append with `push` at a site shared by values of different elements kinds (Smi and object). One deopt of the inlined `push` turns speculation off for that site for good, so every append after it calls the builtin (docs/perf/leads/02, map-bootstrap +11 %). Use a keyed store at `length`.
- A structure cleared every tick should not be a `Map` (the table is dropped
  and re-grown); a scratch array should not be reset with `length = 0`.
- Hand a value down instead of re-deriving it (parent tree, refId from the
  wire header).

## Rejected cleanup (2026-09-23)

Moving the UTF-8 helpers out of `encoding/encode.ts` / `decode.ts` into their own
module (to break the `encode` ↔ `decode` ↔ `varint` import cycle) is a pure move in
source, but measured **+2.6 %** on `encoder/map-replace/str-100pct` (20 samples,
bisected to that change alone; A/A −1.0 %). The cycle is type-level only after
rollup flattens the bundle, so it was left in place.

Also measured and kept (2026-09-23, 20 samples vs 9b9adee, A/A ≤ 1.2 %):

- `CallbacksTable` → plain `RefTable`: `callbacks/density/none` +5.0 % (p .002), `sparse1pct` +2.8 %,
  `dense` +6.0 % (n.s.); `none` +8.8 % on the `--iters 3` re-run (n.s.). The separate `get` stays.
- ×8-unrolled `indexOfRef` / `lastIndexOfRef` → plain loop: `decoder/array-read/indexOf-last` +46 %
  (+44 % on the re-run), `mutations/array-iterate/indexOf-last` +27 %. The unroll stays.
- `KeyedRecorder` page-0 field (lead 01 s2) → directory/pages: see lead 01, Open follow-up.

Also measured and kept (2026-09-23, batch C, 20 samples vs bdf556a):

- `StateCallbackStrategy.triggerChanges`: the seven "listeners backwards in try/catch" loops →
  two module-level helpers (`fire0(list)` / `fire2(list, a, b)`, would remove ~21 LOC).
  Helper tests for the list itself: `callbacks/density/sparse1pct` +7.4 % (A/A 0.0 %), +6.3 % on the
  `--iters 3` re-run. Caller tests first, helper is only the loop: `sparse1pct` +4.5 % (A/A +0.1 %),
  `callbacks/strategies/state` +8.3 % (A/A +2.8 %). The loops stay inline.

- **Shared Map/Set/Stream members installed on the prototypes** (2026-09-23): cold members
  (`maxPerTick` / `priority` accessors, `_dropView`, `_unregister`, the tracking-control
  family) moved to a `sharedMembers.ts` that installs them with `Object.defineProperty` and
  types them by interface merging. Bench-neutral, net −23 LOC, **not landed**: runtime
  installation makes the members undiscoverable from the class body and "go to definition"
  lands on an interface — a worse trade than 23 duplicated lines. Diff kept at
  `%TEMP%\schema-QC-t4.patch` (not in the tree).
