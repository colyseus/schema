# 07 — `tree.values` ↔ `$values` invariant is unenforced

**Status:** closed (2026-09-22) · **Kind:** robustness (no perf) · **Risk:** low

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

## Outcome (2026-09-22)

Landed a small, lead-08-independent change (08's split-id-space work stays parked):

- `Schema.initialize` is **idempotent on an own tracked tree**
  (`tree.ref === instance` and not a decoder stub): the first call builds the
  tree for the final class, so per-inheritance-level calls of an external
  class are no-ops and children assigned between them survive. Anything else
  — no tree, a decoder stub, a foreign tree — gets a fresh tree as before
  (HEAD behaviour; a stub root must become a real tree for `Encoder.setState`,
  and a fresh tree carries no decoder refId).
- Stub detection is positive and copy-agnostic: a prototype getter
  `isTracked` returning `false` on `UntrackedChangeTree` only; any other tree
  counts as tracked. No `instanceof`, no instance field. The tree is read via
  `peekTree` (internal), not the public accessor.
- `[$changes]` setter unchanged (installs as-is). The contract — `values`,
  ownership, `initialize` rules, reader guards — is written once, on
  `ChangeTree.values`; `Schema.initialize` and `REF_ACCESSORS` link to it.
  `forEachChildWithCtx` keeps its `values !== undefined` guard.
- Tests (`test/Metadata.test.ts` › "Schema.initialize idempotence / tree.values
  contract"): two-level external class with a child assigned between the calls
  (encodeAll + incremental), idempotence on a Schema subclass and on an
  external class (all 3 fail on `c8c3bc6`), decoder-built root and child →
  `Schema.initialize` → `new Encoder` + encodeAll round trip (regression guard).
- Bench (`L07b-base` vs `L07b-fix`): tree-build / construct / heavy-tick within
  ±0.6 %, p ≥ 0.6; `bench_encode.js` 5 458 157 bytes.

**Not covered (unsupported / documented only):**
- installing a tree built for another instance via the `[$changes]` setter;
- re-initialize after `Object.setPrototypeOf` to a subclass (the kept tree
  was built for the old class);
- re-initialize no longer resets an attached instance (use `Schema.reset` for
  pooling).
