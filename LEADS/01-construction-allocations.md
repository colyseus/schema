# 01 — Per-instance allocations / GC in construction

**Status:** open · **Kind:** perf + memory · **Risk:** medium

## Evidence

- CPU profile of the `encoder/construct` loop (5 000 bloat players per run) on
  `R5-D`: GC 12 % self, `ArraySchema` constructor 11 %, `MapSchema.set` 10 %,
  `ChangeTree` constructor 3.5 %, `getEncodeDescriptor` 2.8 %. (The
  `ArraySchema` `defineProperty` line, 9.1 %, has been removed since.)
- Every allocation-side change this session paid off more than any compute-side
  one: exact-size `$values` (memory −10 %, construct −26 %, GC time ÷3),
  `refId` / `$changes` off `defineProperty` (construct −32 %).
- `ChangeTree` has ~28 in-object slots; a Schema instance costs its own object +
  `$values` + a ChangeTree; a collection additionally allocates its recorder
  **eagerly** in the ChangeTree constructor (`desc.newRecorder?.()`).

## What each instance allocates today (check before starting)

| instance | allocations |
| --- | --- |
| Schema | instance, `$values` (exact size), ChangeTree |
| MapSchema | instance, `$items` Map, `indexByKey` Map, `keyByIndex` RefTable (object + `page0`), ChangeTree, KeyedRecorder (object + `order` + `pages` + `pageEpoch`) |
| ArraySchema | array, Proxy, ChangeTree, ArrayLog |

## Candidates, cheapest first

1. **Lazy recorder.** Create `tree.rec` on the first recorded op instead of in
   the constructor. A collection that is built and attached detached records
   ADDs immediately, so this mostly helps decoder-side and never-mutated
   collections — measure how many trees ever record before investing.
2. **Lazy `KeyedRecorder` arrays.** `order`, `pages`, `pageEpoch` are three
   array allocations per map; `pages` / `pageEpoch` could start `undefined`
   (as `RefTable` does with its directory).
3. **`MapSchema` maps.** `keyByIndex` could share the lazy pattern; `indexByKey`
   and `$items` are both needed (see lead 05 for why they were not merged).
4. **ChangeTree diet.** List the fields, find the ones only some trees use
   (view bitmaps, stream state, unreliable recorder, `extraParents`, `ops`) and
   move rarely-used groups behind one lazily allocated side object. Watch the
   hidden class: every tree must keep ONE transition path (the constructor
   assigns every slot on purpose).
5. **Schema instance + `$values`.** Could the values live on the ChangeTree
   only (`tree.values`), dropping the own `$values` property? It is public-ish
   (`$values` is exported) and the decoder's direct slots use it — check
   `DecodeInfo.direct` first.

## How to measure

`encoder/construct`, `mutations/tree-build/*`, `encoder/memory-footprint`
(KB/entity, deterministic), `decoder/bootstrap`, `realworld/big-state/*`; watch
the `gcMs` and `heapKb` columns. `--heap-prof` reports memory LIVE at exit
(retention), not churn — use it for "who retains", and line-level CPU ticks plus
`gcMs` for churn.

## Risks

Shape stability of `ChangeTree` (a late-added property costs a transition per
tree and may land out of object — measured once this session: adding
`parentTree` as an extra field cost memory +1.1 %). Always re-check
`%HasFastProperties` / in-object layout with `--allow-natives-syntax %DebugPrint`.
