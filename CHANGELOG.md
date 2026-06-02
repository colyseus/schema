# Changelog

All notable changes to this project are documented in this file. The
format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
