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
