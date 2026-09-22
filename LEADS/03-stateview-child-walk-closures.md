# 03 — Closure per node in StateView / ChangeTree child walks

**Status:** open · **Kind:** perf (allocation) · **Risk:** low

## Evidence

`forEachChild(cb)` goes through `_forEachChildTrampoline` and needs a closure
that captures the caller's state; `forEachChildWithCtx(ctx, cb)` exists
precisely to avoid that (the comment in `treeAttachment.ts` calls the per-call
closure "the #1 JS hotspot in profile-baseline").

`Root.remove` was converted this session (per-depth pooled ctx +
module-level callback): together with the `assertInstanceType` fast path it gave
attach −2.7…−2.9 % and `push-pop-2000` −11 %. `_forEachChildTrampoline` was
still 6.8 % self in the attach / detach loop before that.

Remaining closure-per-node sites (verified with
`grep -rn "\.forEachChild(" src` at `44f64d2`):

| site | runs |
| --- | --- |
| `StateView.ts` — 7 sites: the recursive `add` walk, the `addParentOf` / subscribe walks, `remove` (`changeTree.forEachChild((childChangeTree) => …)`), `_dropPendingEntries` | once per subtree node on every `view.add()` / `view.remove()` / subscribe — the view-churn and area-of-interest paths |
| `Root.ts` — `recursivelyMoveNextToParent` | once per node when a shared instance loses one of several parents |
| `ChangeTree.ts` — `discardAll` (`child.discardAll()`), and the `forEachChild` → `WithCtx` adapter on `UntrackedChangeTree` | per node on `discardAll`; the adapter is decoder-side and cold |
| `MapSchema.clear()`, `SetSchema.clear()` | once per `clear()` (one closure, not per node) |
| `Schema.ts` — `debugRefIds` / debug walk | debug only, ignore |

Start with the two recursive ones in `StateView` (`add`, `remove`): they are the
only sites that allocate per node on a per-tick path.

## Proposal

Same recipe as `Root.remove`: a module-level callback, a ctx object pooled by
recursion depth (`_setParentCtxPool` / `_removeCtxPool` are the templates),
clear the ref-holding ctx fields after the walk so the pool does not keep
detached instances alive.

## How to measure

`stateview/view-churn`, `realworld/entities-aoi/*` (especially `nested`),
`stateview/bootstrap`, `encoder/entity-churn`. Expect low single digits; the
value is mostly less GC on view-heavy rooms.
