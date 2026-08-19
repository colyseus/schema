# Changelog

All notable changes to this project are documented in this file. The
format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [5.0.16]

### Fixed

- **`StateView` operations no longer go stale when the array reindexes later
  in the same tick.** `view.add(item)` followed by an `unshift()`, `reverse()`
  or `move()` on the same `@view` array — within one patch — addressed the
  item's old slot: the added item never reached the client (`"refId" not
  found` on the console), and `view.remove()` in the same position silently
  left the removed item visible. Sibling of the cross-tick case fixed in
  5.0.13.

- **`move()` / `shuffle()` on a `@view`-filtered array no longer corrupt the
  patch for viewing clients.** Reorder operations emitted a refId where
  decoders read an array index. Filtered clients hold per-view subsets, so
  element order is not synchronized for them — reorders now ship as
  identity-based operations existing decoders already understand (no SDK
  update needed).

## [5.0.15]

### Fixed

- **`ArraySchema.reverse()` no longer desyncs clients when it follows another
  change in the same patch.** A `push()`, `pop()`, `shift()`, `unshift()`,
  `splice()` or index write earlier in the tick made the reversal ship wrong
  elements — clients ended up with duplicated or stale entries and never
  recovered. `reverse()` in a tick of its own was already fine. When other
  changes are pending, the reversal now goes out as a full re-state of the
  array (existing wire operations — no SDK update needed), so `onAdd`/`onRemove`
  fire for the re-stated items in that case.

## [5.0.14]

### Fixed

- `SchemaType<>` and `toJSON()` no longer mark every field optional in projects
  compiled with `strictNullChecks: false` (the tsconfig `create-colyseus-app`
  generates) — a Schema instance now satisfies a plain interface like
  `{ x: number }`.

## [5.0.13]

### Fixed

- **`StateView` now addresses the right element after an `ArraySchema` is
  reindexed.** Following a `shift()`, `splice()`, `unshift()`, `reverse()` or
  `sort()`, `view.add(item)` could emit a reference the client was never
  introduced to — `"refId" not found`, the item missing for good, and no
  recovery short of a rejoin — while `view.remove(item)` failed silently,
  leaving an item visible to a client that was meant to stop seeing it.
  Collections that reindex every tick, such as a capped chat or event feed,
  were the most exposed.

  Thanks to [@serjek](https://github.com/serjek) for the detailed report and
  reproduction ([#231](https://github.com/colyseus/schema/issues/231)).

## [5.0.12]

### Added

- **`@fullStateOnly` decorator** — decorator-style equivalent of the
  `.fullStateOnly()` builder chainable, completing delivery-modifier parity
  (`@unreliable` and `@patchOnly` already existed). Combining it with
  `@patchOnly` throws at decoration time, in either decorator order —
  matching the builder's guard.

### Fixed

- `@unreliable` fields now ship their FIRST value on the reliable channel, with
  the owning instance's ADD; only later mutations go out unreliably. Previously
  every value went unreliable, so an instance created after a client connected
  had its `@unreliable` fields written against a refId that client had not been
  told about yet — the decoder dropped those writes, and the value was missing
  until the field changed again (permanently, for a field only written at
  spawn). It bit hardest with the unreliable channel running faster than the
  reliable one, which is the case the split exists for. `encodeAll` already
  seeded these fields for late joiners; a mid-session ADD now matches.

- **A Schema now holds at most 63 fields, down from 64.** The 64th slot could
  encode an operation as byte 255 — the same byte decoders read as
  `SWITCH_TO_STRUCTURE` — which desynchronized every client from that point on,
  with `"refId" not found` in the console. Any nullable field could trigger it,
  not just child `Schema`s and collections, so the slot is withdrawn rather
  than special-cased. A schema with exactly 64 fields now throws where it is
  defined; split it or nest a child Schema. **No SDK decoder change is
  required** — the byte is simply never emitted.

- Defining one field too many now throws, as the error message always claimed.
  The guard was off by one, so the extra field was accepted and then encoded as
  an operation on field 0, corrupting both fields.

- On a Schema with more than 32 fields, an `@view`-tagged field at index 32 or
  above no longer silently hides an untagged field 32 slots below it. That
  field stopped being broadcast — it was routed to the per-view channel
  instead, so clients without a `StateView` never received it, in patches or in
  the initial state. Tagged data was never exposed to the wrong client.

## [5.0.11]

Major release. The encoder internals were rewritten and a new authoring API was
introduced. **Decorators keep working and produce byte-identical output** —
there is no forced migration.

~2.4× faster than 4.0.27 across 51 benchmarked workloads (geometric mean, 50 of
51 at p<0.001), with retained heap roughly halved. Method and full results in
`bench/results/BLOG_v4_vs_v5.md`.

### Added

- **`schema()` + the `t.*` field builders** — decorator-free definitions that
  run in plain JavaScript, with no compiler configuration:

  ```ts
  export const Player = schema({
      name: t.string(),
      hp: t.uint8().default(100),
  }, "Player");
  export type Player = SchemaType<typeof Player>;
  ```

  Returns a real class: `initialize(props)` acts as the constructor body,
  function-valued properties become methods, and `.extend()` builds a real
  prototype chain.
- **Field modifiers** — `.default(value | factory)`, `.optional()`,
  `.deprecated()`, `.view(tag?)`, plus:
  - `.noSync()` — local-only: typed and initialized, never synchronized.
  - `.unreliable()` — patches carry the field on the unreliable channel.
    Primitive fields only.
  - `.patchOnly()` — tick patches only; never in a full state sync, so a late
    joiner never sees it.
  - `.fullStateOnly()` — full state sync only; never in a tick patch. For
    room-wide data set during `onCreate()`.

  Those are the only two delivery channels, so marking a field both throws.
- **`t.stream(Entity)` / `StreamSchema`** — priority-batched collection for
  ECS-style workloads. Additions drain at most `maxPerTick` per client per
  encode pass, ordered by `.priority((view, element) => number)`. `.stream()`
  opts a Map/Set/Collection into the same batching; not supported on
  `ArraySchema`. **Experimental — the API may change.**
- **`view.subscribe(collection)`** — standing per-view subscription to a
  collection's future contents.
- **`t.quantized()` / `t.angle()`** — a bounded float carried as an 8/16/32-bit
  unsigned integer, `"clamp"` or `"wrap"`. Lossy, but identically so on both
  peers, so client prediction and server simulation read the same value.
- **`@colyseus/schema/input`** — `InputEncoder` / `InputDecoder` for the client
  input path, always delta-encoding.
- **`Decoder.decodeResync(bytes)`** — reconcile a full state sync over live
  state on the reconnect path: entries the payload omits are pruned through the
  regular DELETE path, survivors keep instance identity and callbacks. See
  `PORT/resync.md`.
- **`createPool(ctor)` / `Schema.reset()`** — server-side instance pooling for
  spawn/despawn-heavy rooms. Pooled instances encode byte-identically to fresh
  ones. Does not clear primitive values — re-assign every field after
  `acquire()`.
- **Change-tracking control** — `pauseTracking()`, `resumeTracking()`,
  `untracked(fn)`, `markDirty(index)`.
- **Type helpers** — `Data<T>` (the plain data shape of an instance type),
  `BuilderInitProps<T>`, generic narrowing on primitives
  (`t.int8<-1 | 0 | 1>()`), and `Reflection.makeEncodable(ctor)`.

### Changed

- **Raw string field types are rejected by `schema()`** — write `t.string()`.
  They remain valid as collection child types (`t.array("string")`), and the
  `@type("string")` decorator form is unaffected.
- **`Reflection.encode()` takes an `Encoder`**, not a state instance, and
  **`Reflection.decode()` returns a `Decoder`** — read `decoder.state`.
- `defineTypes()` is **soft-deprecated**: works as in 4.x, warns once.
- Default `Encoder.BUFFER_SIZE` raised 8 KB → 16 KB, so typical full-room syncs
  no longer trigger auto-grow plus a one-time `buffer overflow` warning.
- RefIds are allocated monotonically and never recycled — a refId is a stable
  identity for the lifetime of the room.
- Internal `"~prefix"` string keys are real symbols, created via `Symbol.for()`
  so duplicate copies of the library in one realm interoperate.

### Fixed

- `ArraySchema`: consecutive and multi-item `unshift()`, and `unshift()` mixed
  with other same-tick operations (#193). Unshifting Schema instances no longer
  crashes the decoder.
- `ArraySchema`: deletes of Schema children are idempotent, so a client that
  received a full state sync mid-tick no longer corrupts on the next patch.
- `ArraySchema`: interleaving index writes with `shift()` / `splice()` in one
  tick no longer desyncs clients.
- `StateView`: `view.add(obj)` with the default tag no longer leaks
  non-matching `@view(tag)` fields to that client.
- `StateView`: per-tree visibility bits are cleared on dispose, closing an
  ID-reuse leak between views.
- `StateView`: re-adding an already-visible instance to an iterable view no
  longer duplicates it in `view.items`.

### Wire format

Byte-identical to 4.x except for these three, which **every SDK decoder must
implement** for the 0.18 line:

- **`ADD` at an occupied array index means insert**, shifting items up
  (previously only `index === 0` was special-cased). During `decodeResync()`,
  snapshot ADDs remain positional overwrites.
- **`ArraySchema` deletes of Schema children are always `DELETE_BY_REFID`.**
  Decoders must skip operations for unknown refIds entirely — no
  delete-at-`-1`, no spurious `onRemove` — while preserving the ref-count
  decrement.
- **The reflection payload retired its colon grammar.**
  `"quantized:min,max,bits,wrap"` and `"array:string"` are gone: quantized
  descriptors ride as a schema-typed `QuantizedDescriptor` ref, and a primitive
  collection child rides `ReflectionField.childPrimitive`.

`CollectionSchema` / `SetSchema` decoding now preserves the wire index
(`PORT/decoder-wire-index.md`). Fixture generators live in `test-external/`.

## 4.0.30

### `MapSchema.getOrInsert()` and `getOrInsertComputed()`

`MapSchema` now implements `getOrInsert(key, defaultValue)` and
`getOrInsertComputed(key, callbackfn)` — the `Map.prototype` "upsert" methods
from the TC39 proposal, typed in TypeScript 6's standard library:

```typescript
// returns existing value, or inserts (and returns) the default
const player = state.players.getOrInsert(sessionId, new Player());

// same, but the value is only constructed when the key is missing
const player = state.players.getOrInsertComputed(sessionId, () => new Player());
```

Insertions go through the regular `set()` path, so they are tracked and
synchronized like any other change; when the key already exists, the existing
value is returned and nothing is enqueued for encoding.

This also completes the native `Map` contract on TypeScript 6 and 7: with
`lib: ESNext` (where `Map` declares these methods), assigning a `MapSchema`
where a `Map<K, V>` is expected no longer fails — complementing the iterator
fix from 4.0.29. On the runtime side these methods are always available,
regardless of engine support for the proposal.

## 4.0.29

### `MapSchema` iterator type now follows the native `Map` contract

TypeScript 5.6 changed the standard library so `Map[Symbol.iterator]()` returns
`MapIterator` (which includes the iterator-helper methods) instead of
`IterableIterator`. `MapSchema`'s explicit `IterableIterator<[K, V]>` annotation
was narrower, so on TS 5.6+ with `lib: ESNext`:

- assigning a `MapSchema` where a `Map<K, V>` is expected failed with TS2322 —
  even under the recommended `skipLibCheck: true`;
- projects with `skipLibCheck: false` also got TS2416 from the shipped
  declarations (`'[Symbol.iterator]' … is not assignable to the same property
  in base type 'Map<K, V>'`).

`[Symbol.iterator]()` is now typed as `ReturnType<Map<K, V>[typeof
Symbol.iterator]>`, deriving the iterator type from the consumer compiler's own
standard library — `IterableIterator` on TS ≤ 5.5, `MapIterator` on 5.6+. This
is a declaration-only fix; runtime behavior is unchanged.

A new `test:types` check now compiles the generated declarations under strict
`NodeNext` with `skipLibCheck: false` to catch regressions of this kind.

Thanks to [@Hoodgail](https://github.com/Hoodgail) for the contribution (#227).

## 4.0.28

### TypeScript 5 / 6 / 7 compatibility

`@colyseus/schema` now works with any TypeScript major from 5 onwards
(TypeScript 7 is the new Go-based native compiler):

- The `typescript` peer dependency range is now `>=5.0.0` and marked optional —
  installing alongside `typescript@7` no longer fails with `ERESOLVE`, and
  plain-JavaScript projects no longer get a peer warning.
- Internal tsconfigs now pin options whose defaults changed in TypeScript 6
  (`strict`, automatic `@types/*` inclusion), so the package typechecks and
  builds cleanly with 5.x, 6.x and 7.x.
- `schema-codegen` still requires TypeScript 5.x or 6.x installed: TypeScript
  7's native compiler no longer ships the JS compiler API used to parse schema
  files. With `typescript@7` installed it previously exited successfully while
  generating no files — it now fails fast with a clear error message, and the
  CLI exits with a non-zero code on all errors.

The `@type()` decorator (`experimentalDecorators` + `useDefineForClassFields:
false`) remains fully supported by TypeScript 6 and 7.

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
