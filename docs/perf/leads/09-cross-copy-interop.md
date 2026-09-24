# 09 — Two bundled library copies do not round-trip

**Status:** resolved (2026-09-24) — owner decision: supported for identical
builds; implemented per `09-cross-copy-interop-design.md` §6 ·
**Kind:** correctness / product decision

## Resolution

- `$schemaBase` brand (own static on `Schema`, `Symbol.for`) replaces the four
  `!== Schema` checks: a foreign base is never a type nor given metadata.
- `TypeContext.inheritedTypes` lives on
  `globalThis[Symbol.for("@colyseus/schema:inheritedTypes")]`.
- Normalized collection types carry `$collectionCtor`; the decoder builds the
  declaring copy's collection class.
- `makeCollectionSetter` / `MapSchema` ctor: `instanceof` first, then the
  `COLLECTION_KIND` brand on the miss branch adopts a foreign collection.
- `ensureTracked`: `instanceof` first, then `isTracked !== false` keeps a
  foreign tracked tree (only `UntrackedChangeTree` has the getter).
- `Callbacks.get/getLegacy` duck-type the Decoder; a copy of a different
  version warns once at load.
- Custom types stay per copy: call `defineCustomTypes` in every copy.
- `test/CrossCopy.test.ts` loads `build/index.mjs` twice; `npm test` builds it.
  Support matrix: README, "Two copies of the library in one process".
- Mutating a decoded state after re-encoding it still collides refIds —
  lead 08, unrelated to copies.

## Context

`$changes`, `$refId`, `$proxyTarget`, … are `Symbol.for(...)` on purpose, and
`ChangeTree.ts` augments the global `Object` interface with `[$changes]?`, so
that "any Schema / collection instance — regardless of which bundled
`@colyseus/schema` version created it — can be duck-typed" (Cocos Creator
bundles the server and client builds side by side).

## What was measured (two physical copies of `build/index.mjs` in one process; classes from copy A, `Encoder` / `Decoder` from copy B)

- **Decoder of copy B over classes of copy A: throws**, on the round-3 base
  build and on every later one —
  `EncodeSchemaError: a 'Item' was expected, but 'Map' was provided in MapSchema#$items`:
  copy B's decoder builds its own `MapSchema`, copy A's setter asserts
  `instanceof` copy A's `MapSchema`.
- **Encoder of copy B over instances of copy A: runs, but the round-trip is
  wrong** (decoded values do not match), again identically on the base build.

So real cross-copy *runtime* interop does not work today, independent of the
perf rounds; what the shared symbols buy is typing / duck-typing, not driving
another copy's instances. Scratch script used: two copies + a 2 000-tick
encode / decode loop (see `bench/v6-results.md`, "Construction and attach →
Lessons").

## What this round did about it

The private tree slot would have added a second incompatibility (a private
name belongs to one class evaluation), so the stamper class is published under
`globalThis[Symbol.for("@colyseus/schema:TreeStamp")]` and every later copy
adopts the first one: one private name per process. Readers for user-supplied
values still fall back to `target[$changes]` on a miss (older builds keep the
tree on the symbol).

## Decision needed

Is cross-copy runtime interop a supported scenario?

- **No** → say so in the docs, keep the symbols for typing only, and the
  fallback paths can eventually go.
- **Yes** → it needs its own work item: `instanceof` checks
  (`assertInstanceType`, `ensureTracked`'s `child instanceof ChangeTree`,
  `MapSchema` / `ArraySchema` auto-conversion in the setters) must become
  brand / kind checks (`COLLECTION_KIND`, the stamper's slot), the type
  registry and `TypeContext` must be shared or reconciled, and a two-copy test
  (the scratch script above) belongs in the suite.
