# Changelog

All notable changes to this project are documented in this file. The
format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
