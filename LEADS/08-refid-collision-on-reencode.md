# 08 — Re-encoding a decoded state can collide refIds

**Status:** open, pre-existing (not introduced by the perf rounds) ·
**Kind:** correctness · **Risk:** low–medium

## What happens

A decoded state can be handed to a new `Encoder` (peer-to-peer / relay
scenarios; covered for primitive-only trees by
`test/Schema.test.ts` › "should encode map with primitive values from decoded
state"). Decoder-built instances carry an `UntrackedChangeTree` stub;
`ensureTracked` (`src/encoder/changeTree/treeAttachment.ts`) upgrades the stub
to a real `ChangeTree` when the instance is attached, and **keeps the
decoder-assigned refId** (`real.refId = stub.refId`) so identities stay stable.

`Root.add` only assigns a fresh id when `tree.refId === undefined`, and
`Root.nextUniqueId` starts at 0 (or at the `startRefId` passed to the
constructor). So the new Root's allocator knows nothing about the ids that
arrived with the decoded instances: the next instance created on this side gets
`nextUniqueId++`, which can equal an id already in `changeTrees`.

In `Root.add`, `isNewChangeTree = changeTrees.get(refId) === undefined` is then
`false` for the colliding new tree: it is **not registered**, its children are
not walked, and the wire would address two structures with one refId.

The existing comment in the test file already says incremental `encode()` from a
decoded state "emits corrupt indexes"; this is one concrete cause.

## Proposal

On `Encoder.setState` / `Root` construction over a state that already carries
refIds, seed the allocator: walk the attached trees once and set
`nextUniqueId = max(refId) + 1`. `Root.add` could also do it incrementally
(`if (refId >= this.nextUniqueId) this.nextUniqueId = refId + 1`) — one compare
on a path that runs per attached instance; measure `mutations/tree-build` before
choosing that form.

## Test to add

Decode a state with Schema children, attach it to a new Encoder, add a NEW
child on that side, encode, decode into a third instance, `deepStrictEqual` the
JSON and assert every refId in the second Root is unique.
