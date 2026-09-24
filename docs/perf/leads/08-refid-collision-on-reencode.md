# 08 — Re-encoding a decoded state can collide refIds

**Status:** closed (2026-09-24). Owner decision: **hand-off is supported, live relay is not.** · **Kind:** correctness

## What was wrong

`new Encoder(decodedState)` kept the decoder-assigned refIds (`ensureTracked`
copied `stub.refId`; the decoded root kept id 0), but the new `Root`'s allocator
started at 0. The next instance created on the encoder side took an id already
in `changeTrees`, `Root.add` treated it as known, and it was never registered.
Two more bugs sat in the same path:
- a decoded `MapSchema` left `nextIndex` at 0, so the first new key reused wire index 0;
- a decoder-built root (`X.initializeForDecoder()`) crashed with `setRoot is not a function`.

## What landed

The encoder never inherits a decoder id:
- `ensureTracked` (stub → `ChangeTree`) drops the decoder id, sets
  `needsRestage` (the decoded contents were never recorded), and seeds a decoded
  map's `nextIndex` after its highest wire index.
- `Encoder.setState` upgrades a stub root, and clears an id its `Root` did not
  hand out (plus the decoder's lazy `decodeInfo`).
- The `setRoot` walk attaches an upgraded child through `setParent`, so parent
  edges, `@view` filtering and inherited flags match a normally assigned instance.
- A stub's `setParent` upgrades when it is handed a `root` (a decoded instance
  grafted into a running encoder); decoder-side assignments pass none.

## Supported / unsupported

| scenario | |
| --- | --- |
| hand-off: `new Encoder(decoded)`, mutations, new children, `encodeAll` / incremental `encode` into a third decoder | supported |
| decoded subtree under a fresh root, or grafted into a running encoder | supported |
| **live relay**: the same instances keep being decoded from upstream after an Encoder took them | unsupported — throws `cannot decode into an instance attached to an Encoder` |
| a decoded instance shared by two parents | round-trips; the takeover records one parent edge (only `@view` filtering of that instance reads the second) |

Relay would need a "decode into live state" mode: the decoder writes past
tracking on purpose (`values[i]` / `$items` stores), so upstream changes would
never reach the relay's patches even with separate id spaces. Decode into a
separate state and copy instead. The id-only attempt (split decoder/encoder id
spaces, round 3) is at `git show c8c3bc6:LEADS/patches/08-split-refid-spaces-round3.patch`.

Tests: `test/Schema.test.ts` › "hand-off: re-encoding a decoded state".
