# Plan: Split `ChangeTree.ts` into focused helper modules (Option A)

## Brief for next session

`src/encoder/ChangeTree.ts` is currently 1189 lines and owns ~10
distinct responsibilities. Recent perf work (recorder inlining, ops
inlining, Collection inlining via Lever C2) consolidated mutation
state into ChangeTree on perf grounds — that's the right runtime
shape, but it's overloaded the file.

This plan keeps the runtime as a single class (preserves hidden-class
+ IC behavior we tuned) and splits the *file* into focused helper
modules. Methods on ChangeTree become thin pass-throughs to free
functions in dedicated files. Implementations live next to related
implementations; the public method surface on ChangeTree is unchanged.

Read these first:
- `src/encoder/ChangeTree.ts` — current 1189-line state
- `src/encoder/ChangeRecorder.ts` — unreliable-channel storage; not
  touched by this plan
- `EXPLORE_RECORDER_INLINE_OPS.md`, `PLAN_COLLECTION_INLINE.md` — the
  perf decisions that landed the current shape

## Concerns currently in ChangeTree.ts

| # | Concern                                       | Lines (~) |
|---|------------------------------------------------|----------:|
| 1 | Class fields & flag accessors                  |       100 |
| 2 | Inline ops helpers (`_opAt/_opPut/_markDirty`) |        30 |
| 3 | ChangeRecorder API (record / forEach / …)     |       220 |
| 4 | Tree attachment recursion (setRoot/setParent)  |       100 |
| 5 | forEachChild / forEachLive iteration           |       100 |
| 6 | Mutation API (change/delete/operation/…)       |       150 |
| 7 | Encode lifecycle (endEncode/discard/…)         |        70 |
| 8 | Filter/unreliable inheritance                  |       120 |
| 9 | Parent chain (add/remove/find/has/getAll)      |       130 |
|10 | Pause/resume/untracked                         |        25 |

Concerns 1–3, 6, 7, 9 (pause) are core "what ChangeTree does" — stay
in ChangeTree.ts. Concerns 4, 5, 8, 9 (parent chain) are well-bounded
and move out.

## Target file structure

```
src/encoder/
  ChangeTree.ts            (~550 lines — fields, recorder API, mutation API, lifecycle)
  ChangeRecorder.ts        (unchanged — unreliable-channel storage)
  changeTree/
    parentChain.ts         (~130 lines — addParent/removeParent/find/has/getAll)
    inheritedFlags.ts      (~120 lines — _checkInheritedFlags + checkIsFiltered)
    treeAttachment.ts      (~110 lines — setRoot/setParent + ctx pool + hoisted cbs)
    liveIteration.ts       (~50 lines — forEachLive)
```

(Subdir keeps these adjacent to ChangeTree.ts and signals "internal
helpers, not standalone modules".)

## Pattern: thin methods, free-function bodies

Every method on ChangeTree that moves becomes a one-line pass-through:

```ts
// ChangeTree.ts
import { addParent as _addParent, removeParent as _removeParent } from "./changeTree/parentChain.js";

class ChangeTree {
    addParent(parent: Ref, index: number) {
        return _addParent(this, parent, index);
    }
    removeParent(parent: Ref = this.parent): boolean {
        return _removeParent(this, parent);
    }
    // ...
}
```

```ts
// changeTree/parentChain.ts
import type { ChangeTree, Ref, ParentChain } from "../ChangeTree.js";
import { $changes } from "../../types/symbols.js";

export function addParent(tree: ChangeTree, parent: Ref, index: number): void {
    // current implementation, replacing `this` with `tree`
}

export function removeParent(tree: ChangeTree, parent: Ref): boolean {
    // ...
}
```

V8 inlines tiny pass-through methods aggressively. The dispatch cost
should be unmeasurable; we'll verify with a re-bench.

## Migration steps (safe, incremental — one file at a time)

### Step 1 — `parentChain.ts` (lowest coupling)
Methods to move: `addParent`, `removeParent`, `findParent`, `hasParent`,
`getAllParents`. Plus the `parent` and `parentIndex` getters can stay
inline (1-liners reading `parentRef`/`_parentIndex`).

The `ParentChain` interface stays exported from ChangeTree.ts (it's
referenced by IRef etc.) — or move it to parentChain.ts and re-export.

**Validation**: `npm test` (528 passing). No bench needed; pass-through
methods.

### Step 2 — `liveIteration.ts`
Move `forEachLive`. Pure iteration, no shared state, easy to lift.

**Validation**: `npm test`.

### Step 3 — `inheritedFlags.ts`
Move `_checkInheritedFlags` + `checkIsFiltered`. Both protected; the
public-facing `hasFilteredFields` getter stays on ChangeTree (1-liner).

This is the largest extraction. Carefully port the dependencies on
`Metadata`, `$childType`, etc. — nothing changes semantically.

**Validation**: `npm test`.

### Step 4 — `treeAttachment.ts`
Move `setRoot`, `setParent`, `forEachChild`, `forEachChildWithCtx`,
plus the hoisted callbacks (`_setRootChildCb`, `_setParentCtxPool`,
`_setParentChildCb`, `_setParentDepth`).

The hoisted callbacks live with `setParent` — they're the closure-free
optimization for the recursive attach path.

**Validation**: `npm test` + bench_encode and bench_view (10 trials
each). The recursive attach path is performance-sensitive — confirm
no regression.

### Step 5 — final pass
Re-read ChangeTree.ts top to bottom. Anything that's now duplicated,
unused, or oddly placed gets cleaned up. Update the file header
comment to describe the slimmed-down responsibilities.

## Validation criteria

After all steps:
- All 528 tests pass.
- bench_encode median within ±1% of baseline (660 ms).
- bench_view median within ±1% of baseline (1180 ms).
- ChangeTree.ts ≤ 600 lines.
- Each helper file has a single, clear responsibility.
- No new TypeScript diagnostics.

## Risks

1. **Circular imports** — helpers import `ChangeTree` for its type;
   ChangeTree imports helpers for their functions. TS handles circular
   *type* imports fine (`import type`). Use `import type { ChangeTree }`
   in the helpers to break the value-level cycle.

2. **Hidden-class regressions** — adding pass-through methods doesn't
   change the runtime class shape. Methods are on the prototype. Should
   be zero risk, but bench after step 4 to confirm.

3. **Subclass migration later** — if we eventually pursue Option C
   (`SchemaChangeTree` / `CollectionChangeTree`), the file split here
   makes that EASIER, not harder. Helpers operate on the abstract
   ChangeTree interface; subclasses inherit the helpers via the base
   class without touching helper files.

## Open questions

1. **Naming of `_checkInheritedFlags` after extraction** — currently
   protected, prefixed with `_`. As a free function it can become
   `checkInheritedFlags(tree, parent, parentIndex)`. Drop the
   underscore prefix; export with the clean name.

2. **`ParentChain` interface location** — used in multiple places.
   Probably belongs in `parentChain.ts` with a re-export from
   ChangeTree.ts for backward compat.

3. **Should `_opAt/_opPut/_markDirty` move to a `schemaOps.ts` file?**
   They're tightly coupled to ChangeTree's `opsLow/opsHigh/ops` fields,
   and they're hot-path private helpers. Moving them out adds a
   function-call boundary V8 might or might not inline. **Defer** —
   keep them inline in ChangeTree.ts. Same reasoning for
   `readInlineOpByte` (already at module scope, fine where it is).

4. **Should `endEncode/discard/discardAll` go into a `lifecycle.ts`?**
   They're small and tightly coupled to recorder state. **Defer** —
   keep inline. Could revisit if the file is still too big after
   steps 1–4.

## Done criteria

- All 5 steps applied, each with passing tests.
- ChangeTree.ts ≤ 600 lines.
- Bench medians within ±1%.
- Helper files each have a focused docstring describing scope.
- No new TS diagnostics.
- A short note in EXPLORE_RECORDER_INLINE_OPS.md (or a new
  EXPLORE_CHANGETREE_SPLIT.md) recording the file-shape outcome.
