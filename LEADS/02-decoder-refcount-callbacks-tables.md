# 02 — Decoder `refCount` / `callbacks` are integer-keyed plain objects

**Status:** closed, **landed** (2026-09-22, both tables) · **Kind:** perf + memory · **Risk:** low

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

## Outcome (2026-09-22, on `c8c3bc6`)

Both tables moved to `RefTable`, as two frozen builds (`L02-refcount`, then
`L02-both`). `undefined` = not tracked, `0` = released / pending GC: the two
`removeRef` warnings are unchanged. `clearRefs` now `clear()`s the tables in
place. The legacy `getDecoderStateCallbacks` captures `root.callbacks` once, so
after a `clearRefs` it used to keep reading the dropped object. `Schema.debugRefIds`
no longer needs its object / table branch.

**Profile** (`--cpu-prof-interval 100`, line ticks, base build): the `refCount`
lines were 11.6 % of `decoder/churn` (store in `addRef` 6.8 %, `delete` 2.9 %,
decrement 1.3 %, read 0.6 %), 8.3 % of `decoder/map-churn/str`, 10.6 % of
`callbacks/add-remove-churn` and 17.3 % of `decoder/bulk-add/turnover`. The
`callbacks` lines (the `delete` plus the store in `addCallback`) were 0.8–3.3 %.

**Numbers** (10 samples, median. A/A on every flagged row was within ±3.1 %,
except `callbacks/map-churn/num` at +5.5 % in step 2):

| row | refCount (vs base) | + callbacks (vs refCount) | both (vs base) |
| --- | --- | --- | --- |
| decoder/churn | −28.8 % | −8.5 % | **−36.8 %** |
| decoder/map-churn/str | −19.7 % | −7.3 % | **−22.7 %** |
| decoder/map-churn/num | −18.9 % (p .19) | +0.9 % | **−20.7 %** |
| decoder/bulk-add/turnover | −18.2 % | −7.8 % | **−25.6 %** |
| callbacks/add-remove-churn | −16.4 % | −14.6 % | **−29.7 %** |
| callbacks/map-churn/str | −22.7 % | −23.6 % | **−35.4 %** |
| callbacks/map-churn/num | −23.6 % | −12.5 % | **−35.1 %** |
| decoder/bootstrap | +1.9 % | +3.2 % (p .09) | +1.6 % (p .27). At ×3 iters and 16 samples: +1.6 %, p .003, A/A +0.2 % |
| decoder/tick, callbacks/density/\*, callbacks/strategies/\*, bulk-add/bootstrap, realworld decode-10k-callbacks | neutral | neutral | neutral |

The one cost is `decoder/bootstrap` (a fresh Decoder plus a 1000-entity snapshot),
at +1.6 %. A second table now grows by `page0.push` from empty (`RefTable.set`
self time went from 2.6 % to 3.7 %), where before the object's own elements growth
cost 1.6 %. Accepted: about 28 µs per full bootstrap, against −20…−37 % on every
churn row.

Bytes are unchanged (`bench_encode.js` 5 458 157). Tests: 1081 passing, 1 pending.

Seen in the same profiles but out of scope: `for (const index in metadata)` in
`garbageCollectDeletedRefs` is 4.4–7.0 % self time of the same churn loops. That
is a `for…in` over the metadata object for every collected Schema. A per-class
list of the ref-typed field names would skip it, and skip the primitive fields
too.
