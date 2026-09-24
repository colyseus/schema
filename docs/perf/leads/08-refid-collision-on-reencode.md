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
| a decoded instance shared by two parents | supported (the takeover walk records both edges) |
| **live relay**: the same instances keep being decoded from upstream after an Encoder took them | unsupported — throws `cannot decode into an instance attached to an Encoder` (also once the encoder detached it again) |
| an Encoder built over a state only to reflect it (`Reflection.encode(new Encoder(state))`), then decoding into that state | unsupported (same guard): build the Encoder over a spare instance of the class |
| after grafting a decoded subtree, the source decoder keeps decoding the untaken parent (e.g. upstream deletes the grafted entry) | unsupported, NOT detected: the release reads the encoder's refId. Stop the source decoder |
| grafting a Decoder's root instance as a child | unsupported: it keeps the decoder's id 0 (only `new Encoder(root)` resets it) |
| index writes (`arr[i] = v`) on a decoded ArraySchema after hand-off | not recorded (a decoder-built array has no Proxy); use `splice` / `push` |

Relay would need a "decode into live state" mode: the decoder writes past
tracking on purpose (`values[i]` / `$items` stores), so upstream changes would
never reach the relay's patches even with separate id spaces. Decode into a
separate state and copy instead. The id-only attempt (split decoder/encoder id
spaces, round 3) is at `git show c8c3bc6:LEADS/patches/08-split-refid-spaces-round3.patch`.

Tests: `test/Schema.test.ts` › "hand-off: re-encoding a decoded state".
