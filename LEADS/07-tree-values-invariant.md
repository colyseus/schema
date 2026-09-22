# 07 — `tree.values` ↔ `$values` invariant is unenforced

**Status:** open · **Kind:** robustness (no perf) · **Risk:** low

## The invariant

Generated setters write through `treeOf(this).values[fieldIndex]`; the generated
getter reads `this[$values][fieldIndex]`; the encoder reads `tree.values`
(`enterFrame`: `f.values = tree.values`), the attach walk reads
`tree.values[index] ?? ref[name]`. All of that is correct only while
`tree.values === instance[$values]`.

Today that holds because `$values` is created in exactly one place — the
`ChangeTree` constructor (`desc.valuesTemplate.slice()`), or
`Schema.initializeForDecoder` immediately before the stub tree caches it — and
nothing reassigns `instance[$values]` afterwards (verified by grep this
session).

## Where it can break

- The public `[$changes]` **setter** (`defineRefAccessors`) installs any tree on
  any instance; a tree built for another instance carries another `values`
  array. Nothing re-derives `tree.values`.
- Public `Schema.initialize(instance)` run a second time (external classes call
  it once per inheritance level) sets `$values = undefined` and builds a new
  tree; children assigned between the two calls keep a `parentTree` pointing at
  the discarded tree.
- The two readers disagree on the contract: `forEachChildWithCtx` guards
  `values !== undefined`, `enterFrame` / the encode loop do not (collections
  have `values === undefined` and never reach that code).

## Proposal

1. In the `[$changes]` setter (cold path), set `tree.values = this[$values]`
   when the instance is a Schema.
2. Make the second `Schema.initialize` idempotent instead of rebuilding
   (return early when the instance is already stamped and has no recorded
   changes), or document that it must run before any field assignment.
3. One contract for `values`: either always an array (a shared frozen empty
   array for collections) or always guarded.
4. A test that constructs an external class with two inheritance levels,
   assigns a child between the two `initialize` calls, attaches and encodes.

No benchmark needed beyond a `mutations/tree-build` / `encoder/heavy-tick`
non-regression check (the setter path is cold).
