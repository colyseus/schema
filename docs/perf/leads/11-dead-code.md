# 11 — `ArraySchemaInternal.ts` is imported nowhere

**Status:** closed (option 1 + the small items) · **Kind:** cleanup · **Risk:** low

## Evidence

`src/types/custom/ArraySchemaInternal.ts` (~580 lines) exports a second
`class ArraySchema` — the "internal plain array" storage model, where the
instance wraps an `items` array instead of being an `Array` subclass. Nothing in
`src/`, `test/` or `bench/` imports it; the only other mention is a comment in
`src/types/symbols.ts`. Two independent reviewers flagged it this session.

It is not free: every mechanical change to `ArraySchema` has had to be mirrored
into it to keep the build green (the `$refId` / `$changes` accessors, the
`treeOf` / `refTreeOf` conversions, `setParent`'s parent-tree argument, the
stamped-target change) — about one sixth of each sweep's edited surface — and it
is compiled and shipped in the bundle's type surface.

## Why it may be wanted

It is the only thing that could close lead 04 (`indexOf` +80 %, `for…of`
+18 % against 5.x), and `bench/array-impl-comparison.md` compares the two
models. The storage model has been the user's decision throughout, and the
answer so far has been to keep the `Array` subclass.

## Options

1. Delete it; the history keeps it, and `bench/array-impl-comparison.md` keeps
   the numbers.
2. Move it under `bench/` or an `experiments/` directory that is excluded from
   the build, so it stops being swept by every refactor.
3. Keep it, but wire it into the bench harness as a selectable implementation
   so it is at least measured when it is maintained.

## Also small and safe

- `Root.ts` / `Streamable` still declare `[$refId]?: number` on interfaces; the
  property is a prototype accessor now — harmless, but the comments around it
  predate that.
- `TREE_INSTANCES_PER_PLAYER`-style unused exports were removed from
  `bench/lib/fixtures.mjs`; a pass with `noUnusedLocals` over `src/` would find
  the rest (the config has it off).

## Outcome

- Option 1: `src/types/custom/ArraySchemaInternal.ts` deleted, with the
  `SCHEMA_ARRAY_IMPL` resolver plugin in `rollup.config.mjs`; mentions in
  `symbols.ts`, `bench/README.md`, `bench/array-impl-comparison.md` and
  `CHANGELOG.md` point to git history (`16ff6be`). The `$items` symbol and
  the `ref[$items] ?? ref` reads (ChangeTree, DecodeOperation ×2) stay: they
  sit on hot paths and now always resolve to `ref` — a candidate for a
  measured follow-up, not a blind removal.
- `[$refId]?` on `IRef` / `Streamable` now say they are prototype accessors.
- One-off `noUnusedLocals` pass (flag stays off): 24 unused imports / locals
  removed across 15 files. Left on purpose: `FieldBuilder.toDefinition`
  (read via element access), `src/v3_bench.ts` (scratch file),
  every `noUnusedParameters` hit (signature / callback positions).
- `npm test` 1081 passing, 1 pending; `bench_encode.js` 5 458 157 bytes.
