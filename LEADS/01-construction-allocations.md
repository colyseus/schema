# 01 — Per-instance allocations / GC in construction

**Status:** closed (landed as three steps, see Outcome) · **Kind:** perf + memory · **Risk:** medium

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

## Outcome (2026-09-22, worktree `L01`, frozen builds `L01-base` → `L01-s1/s2/s3`)

**Measured first.** An instrumented bundle counted recorders that ever record:
100 % on every fixture and in `bench_encode.js` (50 000 / 50 000 array logs,
5 001 / 5 001 keyed recorders); decoder-built collections carry an
`UntrackedChangeTree` and allocate no recorder at all. Candidates 1 (lazy
recorder) and 3 (lazy `keyByIndex`) therefore have nothing to save and were not
done. The allocation table above holds, with two corrections: the published
ESM build emits native class fields, so **all 28** ChangeTree slots existed
from construction (248 B per tree, 70 % of a 2-field Schema's 354 B), and each
`[]` of `KeyedRecorder` re-grew once on its first op (17-slot backing store).

| step | change | slots / tree |
| --- | --- | --- |
| s1 | dead `$items` indirection: `ChangeTree.elements` slot removed (always `refTarget`), the two `ref[$items] ?? ref` decoder reads read `ref`, `$items` symbol deleted | 28 → 27 |
| s2 | `KeyedRecorder`: page 0 as a direct field, page directory + epoch array only past 4 096 wire indexes (−2 arrays −2 backing stores per map / set) | — |
| s3 | `ChangeTree` diet: `extraParents`, `unreliableRecorder`, `unreliableChangesNode`, `tagBits`, `tagViews`, `subscribedViews` behind one lazily allocated side object (`aux`, accessors keep the names); `metadata` a getter over `encDescriptor`; `paused` a flag bit | 27 → 20 (184 B) |

`%DebugPrint` on fresh / attached / encoded Schema, Map and Array trees: one
shared map before and after, 28 → 20 in-object properties, 248 → 184 B,
0 unused fields, `%HasFastProperties` true.

Retained bytes per instance (20 000 kept): Schema 2 fields 354 → 290 (−18 %),
`MapSchema` + 1 entry 1 827 → 1 403 (−23 %), `ArraySchema` + 5 pushes
1 018 → 954, Tree `Player` 1 692 → 1 444 (−15 %).

Bisect, each build vs `L01-base`, 10 samples/side (✓ p < .05):

| row | s1 | s2 | s3 |
| --- | --- | --- | --- |
| `encoder/memory-footprint` (KB) | −1.1 % ✓ | −1.0 % ✓ | **−8.3 % ✓** |
| `tree-build/construct` | −5.3 % ✓ | −6.6 % ✓ | −4.6 % ✓ |
| `tree-build/attach-fresh` | −1.6 % | −2.3 % ✓ | −3.9 % ✓ |
| `tree-build/attach-steady` | −0.6 % | −0.4 % | −2.5 % ✓ |
| `encoder/construct` | −0.8 % | −1.7 % | +0.6 % ² |
| `decoder/bootstrap` | +0.6 % ² | −1.7 % | +1.7 % ✗ (A/A −0.7 %, p .12) |
| `big-state/encode-10k` / `-20k` | +0.3 / +0.7 ✗ | −1.0 / −0.1 | +1.3 / −0.4 |
| `big-state/decode-10k` / `-20k` | −0.7 / +0.8 | +0.6 / +0.1 | −0.0 / +0.2 |

`bench_encode.js`: 446 ms (base 484–497), 5 458 157 bytes. Open when this was
written: `decoder/bootstrap` +1.7 % at s3 sits at the row's noise floor (its
decoded instances use `UntrackedChangeTree`, untouched) and needs the `--iters
×3` re-read; `big-state/decode-10k-callbacks` and `handshake` failed to launch on
every side (status 0xC0000142, the machine was out of memory) and the broad
`encoder/,decoder/,mutations/,stateview/` compare and `npm test` were still to
run — the bench job was stopped by the harness for memory pressure.

**Not done, and why.** Candidate 5 (`$values` on the tree only): the generated
field getters read `this[$values][i]`; moving the array to the tree adds a
private-slot load and a dependent load to every field READ to save 8 B per
instance, and `$values` is a public export. `_isSchema` → flag bit (184 → 176 B):
it is the per-tree branch of every recorder method; left for a later round.

## Open follow-up (2026-09-23)

Re-check at 20 samples, `W2` (bb40a07) vs the landed build: `encoder/map-encode-all/scores-str-10000`
**+3.6 %** (p < .001, A/A +0.4 %). It is the only row slower than its A/A floor. The broad compare's other two
flags did not reproduce (`map-churn/num-1000` −3.5 %, `unshift-pop-500` +0.6 % n.s.). Suspect: the s2
`KeyedRecorder` change on maps past 4 096 indexes (earlier runs with and without s2 were inconclusive on a noisy
machine). The frozen builds `L01b-s1/s2/s3/s3v/s3v-noS2/final` are in `%TEMP%\schema-L01b\bench\.builds`.
