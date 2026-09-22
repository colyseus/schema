# 02 — Decoder `refCount` / `callbacks` are integer-keyed plain objects

**Status:** open · **Kind:** perf + memory · **Risk:** low

## Evidence

`src/decoder/ReferenceTracker.ts`:

```ts
public refCount: { [refId: number]: number; } = {};
public callbacks: { [refId: number]: SchemaCallbacks } = {};
```

Both are keyed by refId (small, monotonic, never recycled) and both are
`delete`d per collected ref in `garbageCollectDeletedRefs`
(`delete this.refCount[refId]`, `delete this.callbacks[refId]`).

This is exactly the pattern that was expensive on the encoder side:
`Root.changeTrees` as a plain object cost 10.6 % (store) + 3.8 % (`delete`) of
an attach / detach churn loop, and a push-2000 / pop-2000 tick fell off a
dictionary-mode cliff (×100). Moving it to `RefTable` gave
`encoder/map-churn` −25…−29 %, `entity-churn` −22 %. `refs` (the Map) has
already been moved (`decoder/tick` −30 %).

Not yet profiled on the decoder — do that first: `decoder/churn`,
`decoder/map-churn`, `callbacks/add-remove-churn`, `decoder/bulk-add/turnover`
with line-level ticks on `addRef` / `removeRef` /
`garbageCollectDeletedRefs` / `addCallback`.

## Proposal

`refCount = new RefTable<number>()` and `callbacks = new RefTable<SchemaCallbacks>()`.
`RefTable` treats `undefined` as "empty", and a refCount of `0` is a meaningful
value on the decoder (`removeRef` warns on "0 refCount") — store counts as they
are (0 is fine, only `undefined` is reserved) and keep the
`refCount === undefined` / `=== 0` distinctions.

## Blast radius

- Internal: `ReferenceTracker` (add/remove/GC/clear), `Callbacks.ts`,
  `getDecoderStateCallbacks.ts` (`callbacks[refId]?.[…]`), `Resync.ts`.
- Tests index `decoder.root.refCount[refId]` and iterate it with `for…in`
  (`test/Schema.ts` `assertRefParity`, `ArraySchema.test.ts`,
  `InstanceSharing.test.ts`). The encoder-side equivalent was a ~25-site
  mechanical change (`.get(id)`, `.size`, iteration as `[id, value]`).
- External: the JS SDK reads `decoder.root.refs.size` only (checked in
  `colyseus/packages/sdk`); nothing reads `refCount` / `callbacks`.

## How to measure

Decoder churn scenarios above (they warm up for 2 000 frames now),
`realworld/big-state/decode-10k-callbacks`, `callbacks/*`. Bytes are not
involved.
