# Changelog

## 4.0.27

### Encoder: fix `@view` corruption when a filtered patch grows the buffer

With many filtered changes for a client, a single `Encoder` flush could exceed
the default 8 KB `BUFFER_SIZE` and reallocate the shared buffer mid-flush. When
that happened, `encodeView()` / `encodeAllView()` kept slicing from the old (now
discarded) buffer and left the shared iterator's `offset` stuck at the
pre-resize overflow value — so every *subsequent* client in the same flush got a
corrupted patch. The `view.changes` write loop also had no overflow guard, and
its operations are cleared immediately after, so a dropped write couldn't be
recovered by re-encoding. On the decoder this surfaced as misaligned values
(e.g. positions decoding as huge floats), `"refId" not found`, and
`previousValue.entries is not a function`.

It mostly affected rooms with `@view()`-filtered collections holding many
visible children (lots of nearby players/NPCs). Adding fields to those schemas
made it more frequent by enlarging each patch.

Buffer growth is now a single `ensureCapacity()` helper used by both the
`encode()` resize path and the `view.changes` loop; the resize re-encode reuses
the same iterator so `offset` stays accurate; and the per-view methods slice
from the buffer that `encode()` returns. Large filtered patches are also
~15–20% faster, since growth is incremental instead of re-encoding the whole
changeset on every overflow.

Thanks to [@TJEvans](https://github.com/TJEvans) and
[@XT60](https://github.com/XT60) for the report.

## 4.0.26

### Decoder: fix "refId not found" when replacing a collection that holds a shared child

A `Schema` instance shared between a collection and another holder (e.g. an
array element also assigned to a sibling field) could be dropped on the client
when that collection was replaced in the same patch, surfacing as
`"refId" not found` / `trying to remove refId that doesn't exist` decode errors.

The collection-replace path in `decodeValue` was decrementing each previous
child's refId, then `garbageCollectDeletedRefs()` decremented them again — a
*shared* child got double-counted and dropped while still referenced. Child
reference-counting is now left to GC. A guard also releases the previous
collection's own refId when the replacement op isn't tagged `DELETE` (e.g. an
`encodeAll()` not followed by `discardChanges()`), preventing a leak.

Thanks to [@beemdvp](https://github.com/beemdvp) for the report.

### `@view()` now accepts bitwise tags

The `@view()` decorator can now be given a bitmask of tags
(`@view(Tag.A | Tag.B)`). A field becomes visible to any client whose
`view.add(obj, tag)` call shares at least one bit with the field's mask, so a
single field can be exposed to multiple tag audiences at once.

Internally, per-`ChangeTree` tag storage moved from `WeakMap<ChangeTree,
Set<number>>` to a single integer bitmask, with membership resolved via bitwise
`&` instead of `Set` lookups. Custom tags must therefore be powers of two
(`1 << 0`, `1 << 1`, ...). The default `@view()` tag is unaffected.

Thanks to [@FTWinston](https://github.com/FTWinston) for the contribution.

## 4.0.25

### `@view(N)` collections: items pushed after `view.add` are now visible

Items added to a non-default-tag collection (e.g.
`@view(1) @type([Item]) items`) *after* the client called
`view.add(state, 1)` were silently invisible — the array's `ADD` op
was emitted but the new item's fields didn't share visibility with the
parent.

Children of `@view(N)` collections now inherit parent visibility.
Default-tag `@view()` collections keep per-item gating unchanged —
`view.add(item)` is still required to opt each one in.

Thanks to [@FTWinston](https://github.com/FTWinston) for the report
and fix (#226).

## 4.0.24

### `ChangeTree.delete`: fix `encodeAll` dropping sibling fields after `undefined` assignment to a `@view()` field

Thanks to [@Gabixel](https://github.com/Gabixel) for the follow-up
report after 4.0.22.

On a Schema with both `@view()` and non-`@view()` fields, assigning
`undefined` to the `@view()` field evicted an unrelated sibling from
`allChanges`. Incremental clients were fine; a fresh client joining via
`encodeAll()` saw the sibling field silently missing.

`delete()` was picking its target changeset by `filteredChanges !== undefined`
instead of mirroring `change()`'s per-field `isFiltered` test, so the
matching `deleteOperationAtIndex` ran on the wrong side and its
"find last operation" fallback removed a neighbor. Now symmetric with
`change()` across both the `*Changes` and `*allChanges` pairs.

## 4.0.23

### `Callbacks`: accept Schema instances across multiple `@colyseus/schema` copies

The nested-instance overloads of `onAdd`, `onChange`, `onRemove`, and `bindTo`
previously declared `<TInstance extends Schema, ...>`. When two copies of
`@colyseus/schema` end up in `node_modules` (e.g. one in the consuming app and
one transitively pulled in by an SDK), TypeScript infers `data` parameters
with a structural shape that doesn't extend the *local* `Schema` class, and
`TInstance` collapses to the base `Schema`. That made
`CollectionPropNames<TInstance>` evaluate to `never`, surfacing as the
infamous *"Argument of type '"playingUsers"' is not assignable to parameter
of type 'never'"* on otherwise-correct code like:

```ts
callbacks.listen("gameData", (data) => {
    callbacks.onAdd(data, "playingUsers", (user) => { /* ... */ });
});
```

The constraint is now relaxed to match the same pattern already in `listen`:

- `onAdd`, `onRemove`, `bindTo`: `<TInstance, ...>` (no constraint)
- `onChange`: `<TInstance extends object, ...>` — `extends object` is kept
  here only to disambiguate the 2-arg `onChange(instance, handler)` overload
  from the 2-arg `onChange(property, handler)` overload, so a string property
  name still routes to the root-collection form.

Misspelled property names and non-collection properties continue to be
rejected, since `K extends CollectionPropNames<TInstance>` /
`K extends PublicPropNames<TInstance>` still gates them.

Also fixed: `Callbacks.getLegacy()` previously fell through to `undefined`
when the input matched neither `Decoder` nor `{ serializer: { decoder } }`;
it now throws `Invalid room or decoder` to match `Callbacks.get()`.

## 4.0.22

### `StateView`: fix `"refId" not found` from out-of-order `view.changes`

`Encoder.encodeView` iterated `view.changes` in Map insertion order, which
isn't always topological. Sequences that mixed `view.remove` with a later
`view.add` — including `view.add` after re-parenting an instance via a
collection push — could leave a child's entry in the Map ahead of an
ancestor that hadn't been touched yet. The wire stream then emitted
`SWITCH_TO_STRUCTURE` for the child before any earlier op had registered
its refId on the decoder, surfacing as `"refId" not found` (and the
remainder of that patch silently skipped).

`Encoder.encodeView` now iterates in topological order via a DFS
post-order over the parent chain. The pass is gated on a
`StateView.changesOutOfOrder` flag set inside `StateView.remove` (the
only operation that bypasses `addParentOf`'s deepest-ancestor-first
ordering) and reset when `view.changes` is cleared, so the hot path
stays at plain Map iteration when no `remove` happened in the tick.

Same wire-order class as colyseus/colyseus#936; the fix here closes it
at the schema layer so any consumer of `Encoder.encodeView` gets a
topologically ordered stream by construction.

Thanks to @anaibol for the test cases ported from colyseus/colyseus#936
and to @Gabixel for the standalone reproducer at
[Gabixel/colyseus-test-stateview-repo](https://github.com/Gabixel/colyseus-test-stateview-repo).

## 4.0.21

### `@view`: nested Schema fields inherit parent visibility

Previously, when a `@view`-gated field held a nested `Schema`, the nested
instance was encoded but its fields were not — clients would see the reference
but every property came through as `undefined`. The only workaround was to wrap
the nested instance in an `ArraySchema`, which propagated visibility from the
parent.

Nested `Schema` fields now inherit visibility from a `@view`-gated parent
regardless of whether the parent is a collection. Nested fields decorated with
their own `@view` continue to opt out, so explicit per-field gating is
preserved.

Thanks to @FTWinston for the contribution (#218).

## 4.0.20

### C# codegen: emit native `enum` for positive-int enums

The Unity/C# code generator now emits a native `public enum Name : int { ... }`
when every member of a TypeScript enum resolves to a non-negative integer
(implicit index-based or explicit positive int values). String and float enums
continue to emit `public struct` with `public const` fields, since C# native
enums only support integral underlying types.

Benefits: improved type-safety and proper dropdown display for serialized
enum fields in the Unity Inspector.

**Potential source-level break:** native C# enum values are strongly typed,
so comparisons against raw ints now require a cast — e.g.
`if ((int)myEnum == 0)` or, preferably, `if (myEnum == MyEnum.Foo)`.
Wire format is unchanged.
