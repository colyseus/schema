# 08 — Re-encoding a decoded state can collide refIds

**Status:** open — **parked pending an owner decision** (2026-09-22): is re-encoding / relaying a decoded state a supported product scenario? · **Kind:** correctness · **Risk:** medium (grew during the attempt)

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

## Attempt log (2026-09-22) — why it is parked

Four rounds, each reviewed with `/code-review high`:

1. **Per-tree bump in `Root.add`** (`nextUniqueId = max(refId)+1` as trees
   arrive): depends on walk order (a new instance reached before a decoded tree
   with a higher id takes that id); runs on a hot path.
2. **One-time `Root.reserveRefIds` walk in `Encoder.setState`**: misses decoded
   subtrees placed under a fresh root or grafted into a running Encoder; a relay
   that keeps decoding upstream still collides (decoder and encoder share the
   `tree.refId` slot); a decoder-built root crashes (`setRoot is not a function`).
3. **Split id spaces** (decoder id in `decodedRefId` on the stub, encoder ids
   never inherited; stubs upgrade through `setParent` so flags are inherited;
   decoder-only data for upgraded trees in a per-decoder `trackedRecords` Map —
   a process-wide `WeakMap` cost +38 % on `decoder/bootstrap`, all GC). Fixes
   every collision variant and the decoder-built root; 9 behaviour tests; bench
   neutral except `decoder/resync` +2…4 %. Patch + results:
   `patches/08-split-refid-spaces-round3.patch` (applies to `16ff6be`, 3-way on
   `af7686f`), `patches/08-split-refid-spaces-round3-results.md`.
4. **Review of round 3** found what stopped it:
   - `trackedRecords` never shrinks (`removeRef` / GC do not delete) → a relay's
     decoder grows without bound.
   - every decoder stub holds a strong `tracker` back-reference → one retained
     decoded object keeps the whole previous room's decoder (refs, callbacks)
     alive — a **client-side** regression, not relay-only.
   - `state[$refId]` / `refIdOf()` on decoder-side instances return `undefined`
     (was the decoder id) — public behaviour change.
   - `new Decoder(new State())` (the usual client) now pays a Map lookup per
     root chunk (fix: cache the root record on the Decoder).
   - parent edges during takeover: a tracked child under a stub parent keeps
     `parentTree = stub` / gets the parent twice; a decoded instance shared by
     two parents records only one edge.
   - `decodeBody` detects stubs by `decodeInfo` instead of `isTracked === false`;
     record resolution duplicated in three places; `Collection[$resyncPrune]`
     signature not updated.

**Owner decision needed:** is relaying / re-encoding a decoded state a
supported scenario?
- **No / hand-off only** → document that `new Encoder(decodedState)` is
  unsupported (or only for a one-shot hand-off with no further decoding), and
  consider throwing a clear error when an encoder meets a decoder-built tree.
- **Yes** → resume from round 3 with the review list above; keep the decoder's
  per-tree data off the tree entirely (e.g. keyed by refId inside the decoder's
  own `RefTable`s, which it already owns) so neither a leak nor a back-reference
  is needed, and keep `[$refId]` returning the decoder id on decoder-side
  instances.
