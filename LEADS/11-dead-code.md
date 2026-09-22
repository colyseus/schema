# 11 — `ArraySchemaInternal.ts` is imported nowhere

**Status:** open, needs the owner's call · **Kind:** cleanup · **Risk:** low

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
