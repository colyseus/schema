# Changelog

All notable changes to this project are documented in this file. The
format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [5.0.11]

### Fixed
- `StateView`: **custom-tag field leak** — `view.add(obj)` with the
  default tag force-included *all* live fields, including non-matching
  `@view(tag)` fields, whenever the tree had changed while invisible to
  the view. Since the per-view op queue is drained with no per-field tag
  re-check, those fields went straight to the wire: a default-tag client
  received `@view(tag)` data it never subscribed to. Reachable via
  "changed while invisible, then `add()`" and via
  `remove()` → mutate → re-`add()`. Found while evaluating
  [#228](https://github.com/colyseus/schema/pull/228) (the 4.x line
  leaks on the same path). The force-include was the only reader of the
  per-view invisible bit, so the entire invisible-tracking machinery was
  removed with it (`ChangeTree.invisibleViews`, per-tick mark/unmark in
  the encode loop). Benchmarks: view-heavy encode got ~5–6% faster at
  50 views; full-matrix A/B shows no regression, wire bytes unchanged
  outside the leaking scenarios.
- `StateView`: re-adding an already-visible instance to an *iterable*
  view no longer duplicates it in `view.items`; the entry re-enters the
  list after `remove()`. Dedup runs only on the re-add path.

### Notes
- `view.add()` of an already-visible instance intentionally re-queues
  the instance's full snapshot — the shared-view bootstrap re-add idiom
  (a late-attached client may not have consumed earlier drains) depends
  on it. Guard with `view.has(obj)` when cheap idempotence is wanted.
  This and other re-add invariants (same-tick double-add is
  byte-identical to a single add; re-adding a parent repairs a replaced
  `@view()` child) are now pinned by tests.

## [5.0.10]

### Fixed
- `ArraySchema`: consecutive and multi-item `unshift()` — and `unshift()`
  mixed with other same-tick operations — now encode/decode correctly
  ([#193](https://github.com/colyseus/schema/issues/193), port of
  [#219](https://github.com/colyseus/schema/pull/219)). The encoder
  records unshift as a single recorder operation whose map order is the
  wire order (new ADDs stream lowest-index-first); the decoder rule
  generalizes to *"a plain `ADD` at an occupied index means insert at
  that index, shifting items up"* (previously only `index === 0` was
  special-cased as unshift). During `decodeResync()`, snapshot ADDs
  remain positional overwrites. **Wire-semantics change: all SDK
  decoders must mirror the `ADD`-at-occupied-index rule for the 0.18
  line** (see `TODO/sdk-decoders-arrayschema-insert.md`). Also fixed
  along the way: `unshift()` never attached ref-type items to the change
  tree, so unshifting Schema instances crashed the decoder.
- `ArraySchema`: deletes of Schema-type children are now always encoded
  as `DELETE_BY_REFID` (port of
  [#220](https://github.com/colyseus/schema/pull/220); previously only
  view-filtered arrays used it), making array deletes idempotent — a
  client that received `encodeAll()` mid-tick no longer corrupts when
  the next shared patch carries DELETEs recorded before its snapshot.
  The decoder skips stale ops for unknown refIds entirely (no bogus
  delete-at-`-1`, no bogus `onRemove`), while preserving the ref-count
  decrement for items absent from a filtered client's array. Note:
  stale positional ADDs remain unfixable for *primitive* arrays (no
  refId to be idempotent on) — the 0.18 join path must drain the
  pending patch before snapshotting a joining client.
- `ArraySchema`: interleaving index writes with `shift()`/`splice()` in
  the same tick no longer desyncs clients. Index assignments (`arr[i] =
  x`) recorded at items-space positions while deletions record at wire
  (tmpItems) positions; after a same-tick deletion the write landed on
  the wrong wire slot and clobbered staged encode state. All index-based
  recording now translates through the staged-deletion map
  (`$wireIndex`), `shift()` resolves its wire slot structurally instead
  of by value identity, and `unshift()` keeps staged-delete flags
  aligned. Benchmarks: `shift`/`unshift`-heavy mutation ops got ~8%
  faster; full-matrix A/B shows no regression.

## [5.0.9]

### Added
- `defineTypes()` is back as a **soft-deprecated** API — removed in
  5.0.0, it's a big part of legacy plain-JS apps, so it now works again
  exactly as in 4.x (it delegates to the still-supported `type()`
  decorator pipeline, so raw-string fields like `"string"` remain valid
  here). It logs a one-time deprecation warning at runtime, and
  `schema-codegen` parses `defineTypes()` files again (also with a
  deprecation notice). Migrate to `schema()` with `t.*` field builders.

## [5.0.8]

### Added
- `Decoder.decodeResync(bytes)`: full-snapshot reconciliation, built for
  the reconnect path. Decodes a full snapshot (`encodeAll` /
  `encodeAllView` output) and prunes every collection entry the payload
  does not mention, through the regular DELETE path — `onRemove` fires
  with the real previous value, released refs are garbage-collected, and
  surviving entries keep their instance identity and registered
  callbacks. DELETEs that happened while a client was off the wire are
  reconciled as if they had been received; an entry whose occupant was
  *replaced* while offline releases the previous ref (full-sync emits
  plain ADD, never DELETE_AND_ADD, so it would otherwise leak). Safety
  rules: collections that never appear in the payload (`@transient`,
  view-invisible) are left untouched — payload presence is the
  discriminator, since reflection carries no `@transient` metadata;
  `StreamSchema` is exempt entirely (stream contents are trickle-
  delivered — a snapshot is not authoritative for them); and a payload
  that could not be fully decoded (skipped structure / definition
  mismatch) aborts the sweep rather than delete live entries based on
  incomplete visited data. Zero cost on the regular patch path — all
  bookkeeping sits behind a per-call mode check. See
  `PORTING_RESYNC.md` for what other decoder implementations need to
  pick this up.
- `[$resyncPrune]` on the `Collection` interface: each collection kind
  declares its own sweep semantics next to its own storage — maps prune
  by string key (+ journal upkeep, since the decoder journal never
  evicts stale index→key mappings), arrays by resolved index (+
  compaction; `ADD_BY_REFID` lands on the client-side position, so
  visited indexes form a sparse set, not a tail), sets/collections by
  wire index, streams as an explicit no-op. New collection kinds are
  forced by the type system to state theirs.

### Changed
- RefIds are allocated monotonically and **never recycled**.
  `RefIdAllocator` (the reuse pool, its one-tick defer, and the
  resurrection logic — all of which existed only to make recycling safe)
  is deleted; `Root.nextUniqueId` is a plain counter again, which also
  restores DevMode's HMR refId handoff (it reads/writes
  `root['nextUniqueId']`, silently broken since the allocator moved the
  field). Rationale: recycling's safety contract — "the DELETE for the
  old instance reaches the wire before the refId is handed to a new
  one" — is void for a client that is off the wire, so after a reconnect
  a stale client instance could be adopted as an unrelated new entity
  (cross-type: permanent `field not defined` / `definition mismatch`
  spam; same-type: silent aliasing + listener bleed). A refId is now a
  stable identity for the lifetime of the room. Not a wire-format
  change. Measured cost (msgpack number widths step at 128/256/65,536):
  +2 bytes per structure-switch (~+12% on switch-dense patches) only
  once a room exceeds ~65k lifetime allocations (~85 min of heavy
  churn); typical match-length rooms measure ~0%. `bench:gate` flat,
  bytes/op identical.
- `Schema.reset()` instance pooling re-staged retained field values only
  by riding on recycled refIds having a zero refCount; that behavior is
  now explicit via an internal `NEEDS_RESTAGE` flag set by `recycle()`
  and consumed on the next attach. Pooled instances encode byte-
  identically to freshly constructed ones, as before.

## [5.0.7]

### Changed
- Default `Encoder.BUFFER_SIZE` raised from 8 KB to 16 KB. The previous
  default fit ~100-item `MapSchema<{x,y,z}>` collections keyed by
  `nanoid(9)` (~4.5 KB worst case) but with only ~3.5 KB of headroom for
  surrounding state, so typical full-room snapshots were triggering the
  auto-grow + one-time `buffer overflow` warning on first encode. 16 KB
  comfortably fits that scenario plus surrounding state without
  warnings; raise further per app via `Encoder.BUFFER_SIZE = N * 1024`.

### Fixed
- `StateView` + `ArraySchema`: a filtered array element removed via
  `DELETE_BY_REFID` no longer leaks its ref-count on the decoder. That branch
  deleted the element from the array but — unlike `decodeValue`'s DELETE path —
  never called `removeRef`, so the child's ref-count never reached zero and the
  refId was never garbage collected. When the encoder later recycled that refId
  for a new instance, the decoder's stale mapping aliased a *different* type and
  decoding derailed with `@colyseus/schema: field not defined` →
  `definition mismatch` (after which `skipCurrentStructure` silently dropped the
  rest of the patch, leaving stale state). Surfaces only under `StateView`:
  `DELETE_BY_REFID` is emitted solely for filtered `ArraySchema`s, and it takes
  element churn (splice) alongside view-membership churn + refId reuse to expose
  the leak — steady item flows in a fog-of-war room hit it readily. Keyed
  collections (`MapSchema`/`SetSchema`) were unaffected; their filtered deletes
  already route through the `removeRef`-ing path. Regression coverage added to
  `StateView.test.ts` (ref-count parity + no-orphan-refs across
  splice / refId-reuse / resurrection).
- `@colyseus/schema/input` no longer ships a second copy of
  `Schema`/`Metadata`/`TypeContext`/`Encoder`/`Decoder`. The subpath was
  previously built as a standalone bundle that statically inlined the entire
  library, so a consumer importing both `@colyseus/schema` AND
  `@colyseus/schema/input` (any colyseus server using `InputEncoder`/
  `InputDecoder`) ended up with two distinct `Schema` class identities.
  `TypeContext.discoverTypes`'s `parent !== Schema` walk crossed the bundle
  boundary, ran `Metadata.initialize` on the *other* bundle's `Schema`, and
  populated its `[Symbol.metadata]` slot. Subsequent `class extends Schema`
  declarations then inherited that slot via prototype-chain lookup and
  shared its mutable metadata object — under HMR re-evaluation, every
  reload re-stacked fields on top of the previous ones until the 64-field
  cap threw `Can't define field …`.

  The input subpath is now built as a thin (~13 KB vs 310 KB) wrapper that
  externalizes every relative parent import and resolves the identity-
  bearing classes from the main bundle at runtime — one `Schema` per
  process. The main bundle is unchanged for SDK / browser consumers; only
  the input wrapper got smaller.
- `require('@colyseus/schema/input')` no longer crashes under CommonJS. The
  wrapper above rewrote the input bundle's relative parent imports to
  `@colyseus/schema`, but the rewrite only matched the ESM `from "../…"`
  form — the CJS build kept emitting `require('../encoding/spec.js')` and
  friends, files that bundle never ships, so any CommonJS server (the
  default `create-colyseus` + `tsx` setup) died on boot with
  `Cannot find module '../encoding/spec.js'`. The bundler now rewrites the
  `require('../…')` form too, so both the `require` and `import` conditions
  resolve to the main bundle. A packaging smoke test (`npm run test:exports`)
  now loads every `exports` subpath under both conditions and gates publish.

## [5.0.6]

### Added
- `Data<T>` type helper — the plain DATA shape of a Schema instance type: its
  synchronized fields with all `Schema` machinery stripped (`assign`, `clone`,
  `toJSON`, change-tracking state, internal symbol keys, …), so a plain object
  literal satisfies it while field types (including narrowed primitives like
  `t.int8<-1 | 0 | 1>()`) are preserved.

  ```ts
  function applyInput(state: Player, cmd: Data<MoveInput>) { … }
  applyInput(player, { moveX: 1, jump: false, dt });   // plain literal — OK
  ```

  For typing code that works on schema-shaped *plain objects* rather than
  decoded instances: deterministic simulation steps, synthesized / buffered
  input commands, plain DTOs. Unlike `ToJSON<T>` (a recursive serialization
  shape that retains non-method `Schema` members), `Data<T>` is a flat
  structural projection — `Omit<T, keyof Schema>` — that plain literals satisfy.

## [5.0.5]

### Added
- Generic type narrowing on the primitive field factories. Pass an explicit
  type argument to `t.int8()` / `t.string()` / etc. to refine the inferred
  field type, while the wire encoding is unchanged:

  ```ts
  const MoveInput = schema({
      moveX: t.int8<-1 | 0 | 1>(),         // typed -1 | 0 | 1, still a 1-byte int8
      team:  t.string<"red" | "blue">(),   // typed "red" | "blue", still a string
  });
  ```

  Each `t.<primitive>()` now has two call signatures: the bare call returns the
  natural type for the codec (`t.int8()` → `number`), and an explicit type
  argument returns `FieldBuilder<T>`. This is an overload pair rather than a
  defaulted generic (`<T extends TBase = TBase>()`): a defaulted free type
  parameter gets captured as `any` during `schema()`'s self-referential field
  inference (and `undefined extends any` then flips every field optional), so
  the bare form must stay a concrete `FieldBuilder<TBase>`.

  The refinement is a **type-level assertion only** — the wire still carries the
  codec's full range and the decoder writes whatever bytes arrive. Sound for
  server-authored state; for input schemas (untrusted client) keep validating /
  clamping on receipt.

## [5.0.4]

### Added
- `FieldBuilder#noSync()` — chainable modifier that marks a field as
  **local-only**. The field is still typed on the inferred instance and
  still honors `.default()` / `.optional()` / collection auto-instantiation,
  but it is never registered for synchronization: it skips change tracking,
  is never encoded, and decoders never receive it. Useful for server-side
  scratch state or per-peer UI state you want on the class for typing
  convenience without paying any sync cost.

  ```ts
  const Player = schema({
      hp: t.uint8().default(100),          // synchronized
      lastInputTick: t.number().noSync(),  // local-only, never sent
  }, 'Player');
  ```

  Combining `.noSync()` with a sync-only modifier (`.view()`, `.owned()`,
  `.unreliable()`, `.transient()`, `.static()`, `.stream()`) throws at
  `schema()` time, since a local-only field cannot be synchronized.

### Changed
- `FieldBuilder`'s internal configuration fields (`_type`, `_default`,
  `_view`, `_noSync`, …) and `toDefinition()` are now declared `private`,
  so editor autocomplete on `t.number().` surfaces only the chainable
  fluent modifiers. The fields remain reachable at runtime via element
  access (e.g. `builder['_noSync']`) for internal tooling, but are no
  longer part of the intended public API.

### Fixed
- `npm test` now points at mocha's JS entry (`node_modules/mocha/bin/mocha.js`)
  instead of the `.bin/mocha` shim. Under pnpm the shim is a POSIX shell
  script, which `tsx` tried to parse as JavaScript and failed with
  `SyntaxError: missing ) after argument list`.
- Resolved a duplicate `typecheck` script key in `package.json`; the
  build-config typecheck is now available as `typecheck:build`.

## [5.0.3]

### Added
- `Reflection.makeEncodable(ctor)` — opt-in upgrade for classes
  reconstructed via `Reflection.decode`. Installs the same prototype
  accessor descriptors and `metadata[$encoders]` lookup table that the
  `schema(...)` / `@type` builders install at class-definition time, so
  the reconstructed class becomes usable as an encode source for
  `InputEncoder` and `Encoder`. Idempotent. `Reflection.decode` itself
  is unchanged — decoder-only callers (the dominant case) pay nothing
  extra; only code that explicitly opts in pays the descriptor + encoder
  install cost. This unblocks Colyseus 0.18's reflection-based input
  schema discovery, where the SDK reconstructs the input class from the
  server's JOIN_ROOM handshake bytes and then needs to encode against
  it.
- `Metadata.defineField(target, metadata, fieldIndex, fieldName, type)`
  — internal helper that folds the per-field install logic (descriptor
  build, prototype install, `$encoders` slot) into a single shared path.
  Called by both `Metadata.setFields` (build path) and
  `Reflection.makeEncodable` (Reflection upgrade path) to keep the
  field-installation logic in one place.

## [5.0.2]

### Fixed
- Re-export `BuilderInitProps` from the package entry. Without it,
  consumers using `schema()` could hit ts(2883) — `The inferred type of
  'X' cannot be named without a reference to 'BuilderInitProps' from
  '../node_modules/@colyseus/schema/build/types/HelperTypes.js'` — when
  TypeScript emitted declarations for inferred schema types.

## [5.0.1]

### Added
- `FieldBuilder#optional()` — chainable modifier that marks a field as
  optional. Widens the inferred instance type to `T | undefined` and skips
  auto-instantiation of collection / Schema-ref defaults at construction.
- `BuilderInitProps<T>` — new helper type that derives a strict
  constructor-props shape from a `schema()` fields map. Required fields
  (primitives without `.default()` / `.optional()`, and Schema refs with a
  non-zero-arg `initialize()`) must now be provided at construction;
  optional fields remain omittable.

### Fixed
- Internal symbols (`$refId`, `$changes`, `$childType`, `$proxyTarget`,
  `$values`) now use `Symbol.for(...)` so duplicate copies of
  `@colyseus/schema` loaded into the same JS realm — for example, the
  `./input` subpath bundle alongside the main bundle — share identity and
  can read each other's tagged instances. Previously, each copy created
  its own `Symbol(...)`, breaking cross-bundle property access. A small
  polyfill installs at module load for runtimes lacking `Symbol.for`,
  using a `globalThis`-anchored registry so cross-copy sharing still
  works there.

### Changed
- `InferSchemaInstanceType<T>` now marks `.optional()` fields as `?:`,
  preserving the mandatory-by-default typing for every other field.
- `Schema#toJSON()`'s return type respects `.optional()` (fields whose
  generic admits `undefined` are emitted as `?:`), matching the runtime
  behavior that omits `null`/`undefined` fields.
- `schema().extend()` merges parent+child fields into init-props so child
  constructors accept parent-declared fields when no `initialize()` is
  declared.
- Constructor signatures: schemas with an explicit `initialize(arg)` keep
  strict required args; otherwise `[] | [InitProps]` is accepted —
  preserving the `new X(); x.field = ...` deferred-assignment pattern
  while catching incomplete partial objects like `new X({ hp: 1 })`.
- `FieldBuilder` now carries two phantom generics
  (`<T, HasDefault extends boolean, IsOptional extends boolean>`) so the
  init-props derivation can distinguish required vs. omittable fields
  without runtime cost.

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
