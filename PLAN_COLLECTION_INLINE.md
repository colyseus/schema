# Plan: Inline `CollectionChangeRecorder` onto `ChangeTree` (Lever C2)

## Brief for next session

This plan is the entry point for a fresh session. The previous session
landed:
- StateView per-tree visibility bitmap (#3a from earlier)
- StateView per-tag bitmap (replaces `tags: WeakMap`)
- Schema-side recorder inlined onto ChangeTree (3a)
- Schema ops storage inlined for ≤8 fields (Lever A — commit `722a070`)

What's left from "Recorder alloc on ChangeTree": **the Collection
side**. Every MapSchema / ArraySchema / SetSchema / CollectionSchema
still allocates a separate `CollectionChangeRecorder` object + its
internal `Map` and `Array`. This plan finishes the unification.

Read these first to load context (in order):
- `EXPLORE_RECORDER_INLINE_OPS.md` — what 3a + Lever A did and why.
- `src/encoder/ChangeTree.ts` — current state. The Schema-inline
  pattern (`this.recorder === this`, `_opAt/_opPut/_markDirty`
  helpers, hot-path forEach) is the model to mirror.
- `src/encoder/ChangeRecorder.ts` — `CollectionChangeRecorder` class
  (lines 194–315). This is what we're folding in.

## What we're attacking

### Per-Collection allocation cost

`ChangeTree.ts:221` for every Collection (Map/Array/Set/CollectionSchema):

```ts
this.recorder = new CollectionChangeRecorder();
```

Inside that recorder:
```ts
private dirty: Map<number, OPERATION> = new Map();
private pureOps: Array<[number, OPERATION]> = [];
```

**Three allocations per Collection** (recorder object + Map + Array).
On `bench_encode`: ~300 collections/iter × 100 = ~30k Collection allocs
total → ~90k underlying objects.

### Per-call dispatch cost

Every Collection mutation goes through `this.recorder.{record,
recordDelete,recordRaw,recordPure,operationAt,setOperationAt,forEach,...}`.
At Schema call sites the IC sees ChangeTree (Schema-inline) and
CollectionChangeRecorder polymorphically — bimorphic, slower than
monomorphic. The 3a/Lever A work proved direct calls win here.

## The architectural question

We previously *split* recorder responsibility off `ChangeTree` for
"separation of concerns". The 3a work (Schema-side) and Lever A
(Schema ops storage) effectively re-merged half of it back on perf
grounds. C2 finishes the merge for the Collection side.

The legitimate concern: **does ChangeTree become a god class?** Two
honest framings:

1. **No, this is its actual responsibility.** "Track changes for one
   ref" is what ChangeTree exists to do. The only ref types we have
   are Schema and Collection (Map/Array/Set/CollectionSchema share
   shape). All change-tracking state being on ChangeTree is the
   simplest possible decomposition.

2. **Yes, and the alternative is a class hierarchy.**
   `SchemaChangeTree extends ChangeTree` +
   `CollectionChangeTree extends ChangeTree` keeps state segregated
   per subclass. No shape pollution. Methods polymorphic per subclass.

The choice is real. This plan recommends **option 1 (single class)**
as the first step because (a) smallest diff from current state, (b)
the `recorder === this` pattern is already proven in change() /
indexedOperation(), (c) reversible if shape pollution shows up in
profiles. If a second pass shows hidden-class issues, we promote to
two-class.

## Design — single-class approach

### Storage

Add to `ChangeTree`:

```ts
// Collection-only storage. Undefined for Schema trees.
collDirty?: Map<number, OPERATION>;
collPureOps?: Array<[number, OPERATION]>;  // lazy: undefined unless CLEAR/REVERSE recorded
```

Schema-only state already there (`dirtyLow`, `dirtyHigh`, `opsLow`,
`opsHigh`, `ops`). Collection trees never touch them.

A discriminator field is needed for the dispatch:

```ts
private _isSchema: boolean;  // set in ctor, never changes
```

(Or reuse `recorder === this` as the discriminator. `recorder` field
becomes unused once Collection is inlined; might as well delete it
and add `_isSchema`. Cleaner long-term.)

### Ctor

```ts
constructor(ref: T) {
    this.ref = ref;
    this.metadata = (ref.constructor as typeof Schema)[Symbol.metadata];
    const isSchema = Metadata.isValidInstance(ref);
    this._isSchema = isSchema;

    if (isSchema) {
        const numFields = (this.metadata?.[$numFields] ?? 0) as number;
        if (numFields > 7) this.ops = new Uint8Array(numFields + 1);
        // opsLow/opsHigh default to 0
    } else {
        this.collDirty = new Map();
        // collPureOps stays undefined — lazy
    }
}
```

### Method dispatch shape

For each ChangeRecorder method, branch on `_isSchema`:

```ts
record(index: number, op: OPERATION): void {
    if (this._isSchema) {
        // existing Schema path: _opAt/_opPut/_markDirty
    } else {
        // existing CollectionChangeRecorder.record body, but operating
        // on this.collDirty directly
        const prev = this.collDirty!.get(index);
        const finalOp = (prev === undefined)
            ? op
            : (prev === OPERATION.DELETE ? OPERATION.DELETE_AND_ADD : prev);
        this.collDirty!.set(index, finalOp);
    }
}
```

Same shape for `recordDelete`, `recordRaw`, `recordPure`,
`operationAt`, `setOperationAt`, `forEach`, `forEachWithCtx`, `has`,
`size`, `reset`, `shift`.

The `_isSchema` branch is per-tree-stable (set once in ctor) so V8's
branch predictor + IC turn it into near-zero cost. Same trick we used
for `ops !== undefined` in Lever A.

### Schema fast-paths in change() / indexedOperation()

Currently:
```ts
if (this.recorder === this) {
    this.record(index, operation);  // Schema fast-path
} else {
    this.recorder.record(index, operation);  // Collection
}
```

After C2 (recorder field deleted):
```ts
this.record(index, operation);  // single dispatch, branches internally
```

Lose the explicit dual call site, but `record()` itself now branches.
Net same number of branches; net win is the deleted CollectionChangeRecorder
allocation + dispatch.

If profile shows the internal branch hurts more than the `recorder ===
this` branch helped, the rollback is to keep the explicit branch and
have two specialized methods (`recordSchema` + `recordCollection`).

### Lazy `collPureOps`

`pureOps` is only used for `CLEAR` (Map/Array/Set/Collection) and
`REVERSE` (Array). Most workloads never CLEAR or REVERSE.

```ts
recordPure(op: OPERATION): void {
    if (this._isSchema) throw new Error("Schema: pure ops unsupported");
    (this.collPureOps ??= []).push([this.collDirty!.size, op]);
}
```

`forEach` checks `if (this.collPureOps !== undefined && pureOps.length > 0)`
— same branch as today. Already-implemented in CollectionChangeRecorder.forEach.

## Migration steps

1. Add `_isSchema`, `collDirty?`, `collPureOps?` to ChangeTree.
2. Update ctor to populate them.
3. Port each `CollectionChangeRecorder` method body into `ChangeTree`'s
   corresponding method, gated on `!this._isSchema`. Schema branches
   stay as-is.
4. Delete `this.recorder` field. Remove all `this.recorder.X` call
   sites — they become `this.X`.
5. Delete the `CollectionChangeRecorder` class (or keep as a private
   stub if anything external imports it; check exports).
6. Update `ensureUnreliableRecorder()` — currently allocates either a
   SchemaChangeRecorder OR CollectionChangeRecorder. The unreliable
   recorder pattern would also need to be folded in (see open
   question #3 below).

## Validation

After each step:
- `npm test` (currently 528 passing, 13 pending)
- `node bench_encode.js` × 10, median vs baseline (660 ms post-LeverA)
- `node bench_view.js` × 10, median vs baseline (1180 ms post-LeverA)
- `node --prof bench_encode.js` once at the end to confirm
  `CollectionChangeRecorder` no longer in the top allocators

Expected wins:
- bench_encode: ~3-5% (Collections are fewer than Schemas; this saves
  per-Collection alloc + dispatch)
- bench_view: smaller (view bench has fewer collection mutations)
- The bigger qualitative win: simpler code, one place for all
  change-tracking state, deletes ~120 lines from ChangeRecorder.ts

## Risks

1. **Shape pollution** — every ChangeTree now has slots for both Schema
   and Collection state, most undefined. V8 hidden classes should
   handle this fine *if all slots are assigned in the ctor* (even to
   undefined). Lazy-assigning post-ctor causes hidden-class transitions
   and is the main thing to avoid.

2. **Branch prediction** — the `_isSchema` branch is per-tree-stable.
   At a given call site (e.g. inside Encoder's encode loop), it'll be
   either always-true or always-false depending on which tree is being
   processed. V8's branch predictor handles this well in practice.

3. **`this.recorder` removal** — there might be call sites outside
   ChangeTree.ts that read `this.recorder`. Audit before deleting.
   Quick grep:
   ```sh
   grep -rn "\.recorder" src/
   ```

## Open questions to resolve in implementation

1. **Should we promote to two-class (SchemaChangeTree /
   CollectionChangeTree)?** Defer until single-class profile lands.
   If `_isSchema` branch shows up as a hot deopt or hidden-class
   transitions are visible, escalate.

2. **Unreliable recorder shape** — currently
   `this.unreliableRecorder?: ChangeRecorder` lazy-allocates either a
   SchemaChangeRecorder OR a CollectionChangeRecorder. After C2:
   - Option A: keep separate ChangeRecorder objects for unreliable
     (smaller diff, unreliable is opt-in / rare).
   - Option B: inline unreliable state too — `unreliableDirtyLow/High`,
     `unreliableOps?`, `unreliableCollDirty?`, etc. Bigger diff,
     completes the unification.
   Recommend A for now.

3. **Should `ChangeRecorder` interface die entirely?** With Schema and
   Collection both inlined, the only consumer is `ensureUnreliableRecorder()`.
   If we go with question-2 Option A, the interface stays for
   unreliable. If Option B, interface can be deleted.

4. **Public API exposure of `CollectionChangeRecorder`** — check
   `src/index.ts` exports. If exposed, we either keep it as a thin
   shim or treat its removal as a breaking change in 5.0.

## File touch list

Direct edits:
- `src/encoder/ChangeTree.ts` — add fields, ctor, port methods, delete recorder dispatch
- `src/encoder/ChangeRecorder.ts` — delete CollectionChangeRecorder (or stub if exported)
- `src/encoder/Encoder.ts` — audit any `tree.recorder.X` references

Indirect (audit only):
- `src/types/custom/MapSchema.ts`, `ArraySchema.ts`, etc. — confirm
  they don't reach into `recorder` directly
- `src/index.ts` — exports

## Done criteria

- All 528 tests pass.
- bench_encode median strictly ≤ baseline (660 ms).
- bench_view median strictly ≤ baseline (1180 ms).
- `CollectionChangeRecorder` class deleted (or stubbed if exported).
- `tree.recorder` references zero in src/ (or one if kept for
  unreliable).
- No new TypeScript diagnostics.
