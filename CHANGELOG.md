# Changelog

All notable changes to this project are documented in this file. The
format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
