# Decoder: preserve wire-index for SetSchema / CollectionSchema

> Scope: all SDK decoders (C#, C++, Lua, Haxe, Java, etc.) implementing
> the schema wire format for `SetSchema` and `CollectionSchema`. The TS
> reference implementation was fixed in commit `1b8a3c3` — the same
> bug pattern exists in every port's `decodeKeyValueOperation` handler
> and must be fixed identically.

## What the bug looks like

Every time a SetSchema / CollectionSchema ADD op arrives on the wire,
naïve decoder ports call their local `ref.add(value)` equivalent. That
function increments a decoder-side monotonic counter (`$refId++`) and
stores the value at that decoder-local index — *discarding the
wire-index that was just decoded*.

```
# pseudo-code the fix replaces
index = read_uvarint()                      # wire-index from server
value = decode_value(...)                   # refId resolution etc.
ref.add(value)                              # WRONG: uses ref's own $refId++
```

This happens to "work" as long as the server sends exactly one ADD per
logical item. If the server **re-emits** the same wire-index (which
is normal — see below), the decoder appends a new entry per emission.

Observable symptom: `assert state.collection.size == 2` fails with
`size == 4` after a bootstrap encode. SetSchema hides the bug because
`add()` on many ports dedupes by value identity; CollectionSchema (a
multiset) doesn't.

## When does the server re-emit?

Standard Colyseus room bootstrap emits each initial item twice:

1. `encodeAll` walks the live structure via `forEachLive` and emits
   every populated wire-index as an ADD op.
2. Immediately after, the same tick's `encode()` walks the tree's
   dirty-state recorder — which also has those same ADDs queued from
   the `.add()` calls — and emits them a second time.

Both emissions carry the **same wire-index**. A correct decoder must
be idempotent on re-decoding the same `(refId, wire-index)` pair.

The same pattern also surfaces in `view.subscribe()` (a Colyseus 5.0
feature): the subscription's bootstrap seeds `view.changes` with force-
ADDs while the parent collection's recorder independently queues the
same ADDs. Duplicate-emit again.

## Correct decode logic

```
# pseudo-code — per-language adaptation required
index = read_uvarint()             # wire-index from server
value = decode_value(...)

if ref.has_key(index):             # idempotent on re-decode
    # already placed — no-op
    pass
else:
    ref.items[index] = value       # place at the WIRE-index, not a local counter
    if ref.refId_counter <= index: # keep counter ahead of seen indexes
        ref.refId_counter = index + 1
    ref.set_index(index, index)    # protocol symmetry with MapSchema
```

The three parts matter:

1. **`has_key` dedup** — makes re-decoding idempotent. Critical for
   CollectionSchema (multiset with no value-dedup); defensive for
   SetSchema (so its correctness no longer depends on `has(value)`
   catching re-emissions).
2. **Wire-index placement** — `ref.items` must be keyed by the
   server's wire-index so DELETE ops (which carry the wire-index)
   find the right entry. If the decoder stored values at different
   indexes than the server, later DELETE ops would miss.
3. **Counter advancement** — if the server later allocates new
   indexes via its own `$refId++`, they must be above anything
   we've already placed. Keep the decoder's counter synchronized so
   subsequent server/client `.add()`s stay aligned.

## TypeScript reference

`src/decoder/DecodeOperation.ts`, inside `decodeKeyValueOperation`:

```ts
} else if (typeof((ref as any)['add']) === "function") {
    // CollectionSchema && SetSchema — use the wire-index we
    // decoded above so server/client `$items` stay in sync
    // regardless of duplicate emission (e.g. a bootstrap that
    // walks both `encodeAll` and the shared recorder emits the
    // same ADD op twice).
    const r = ref as any;
    if (!r.$items.has(index)) {
        r.$items.set(index, value);
        if (typeof r.$refId === "number" && index >= r.$refId) {
            r.$refId = index + 1;
        }
        r["setIndex"]?.(index, index);
    }
}
```

The outer `index` is the already-decoded wire-index (from
`decode.number(bytes, it)` a few lines above). The previous
implementation redeclared `const index = ref.add(value)` inside the
branch, shadowing the wire-index — that's what every SDK port needs
to stop doing.

## Why this only affects SetSchema / CollectionSchema

| Collection | Wire addressing | Prior bootstrap behavior |
|---|---|---|
| `ArraySchema` | positional (`$setAt(index, value)`) | idempotent — same index overwrites |
| `MapSchema` | keyed (`$items.set(key, value)`) | idempotent — same key overwrites |
| `SetSchema` | wire-indexed but decoded via `add(value)` | accidentally-idempotent via `has(value)` dedup, but fragile |
| `CollectionSchema` | wire-indexed but decoded via `add(value)` | **broken** — every re-emission appends |
| `StreamSchema` | wire-indexed, decoded via `add(value)` too | **potentially broken** for same reason — apply identical fix |

**Apply the same fix to every port's `StreamSchema` decode path** if
the SDK has one — it shares `SetSchema`'s decode handler in the TS
reference and inherits the same risk.

## Test to mirror when porting

`test/ViewSubscribe.test.ts` has a CollectionSchema subscribe test
that bootstraps via `encodeMultiple` (triggers the duplicate-emit).
Ports should replicate the scenario and assert `state.collection.size
== expected`, not `>= expected`.

```
state.notices.add(noticeA)
state.notices.add(noticeB)
# client receives bootstrap emit…
assert client.state.notices.size == 2   # not 4
```

## Commit reference

- `1b8a3c3` — fix(decoder): preserve wire-index in CollectionSchema /
  SetSchema decode
- Detected while implementing `view.subscribe(collection)` (commit
  `a68c0e0`) — the subscribe feature exposed the duplicate-emit path
  that had always existed during normal bootstrap but nobody tested
  CollectionSchema under a StateView.
