# Wire format — version 6

The reference for the bytes `@colyseus/schema` 6.x puts on the wire. Every
other language decoder (C#, Lua, Haxe, …) implements this document.

Contents: [primitives](#primitives) · [message and chunks](#message-and-chunks)
· [Schema ops](#schema-ops) · [keyed collections](#keyed-collections-map--set--collection--stream)
· [arrays](#arrays) · [ref values and bodies](#ref-values-and-bodies)
· [handshake](#reflection-handshake) · [encoder rules](#encoder-rules)
· [decoder rules](#decoder-rules) · [callbacks](#callbacks)

## Primitives

| item | encoding |
|---|---|
| `uvarint` | unsigned LEB128: 7 bits per byte, low group first, high bit = continuation. 1 byte < 128, 2 bytes < 16 384, 3 bytes < 2 097 152. Used for every structural integer: refIds, field / entry indexes, counts, lengths, type ids, revisions. |
| `string` | `uvarint(utf8ByteLength) utf8Bytes`. `null` / `undefined` ride as `""`. |
| fixed-width types | `int8…int64`, `uint8…uint64`, `float32`, `float64`, `bigint64`, `biguint64`, `boolean` — little-endian, no tag. |
| `number` (dynamic) | msgpack-shaped: positive fixint `0x00–0x7f`, negative fixint `0xe0–0xff`, `0xcc/0xcd/0xce` uint8/16/32, `0xd0/0xd1/0xd2` int8/16/32, `0xca` float32 (chosen when `|f32(v) − v| < 1e-4`), `0xcb` float64 (also integers beyond 32 bits). `NaN` rides as `0`, `±Infinity` as `±MAX_SAFE_INTEGER`. |
| quantized | raw `uint8/16/32` per the field's `bits`. |

## Message and chunks

```
message      := chunk*
chunk        := uvarint(refId) uvarint(byteLen) ops[byteLen]
```

A message is a sequence of chunks, each addressing one structure by refId and
carrying exactly `byteLen` bytes of ops for it. There is no reserved byte: a
decoder that does not know `refId` skips `byteLen` bytes and continues. Which
op grammar applies is decided by the kind of the structure the refId names
(Schema, Map, Array, Set/Collection/Stream). The root structure has refId 0.

A full sync (`encodeAll`) is one root chunk whose ref values inline their
bodies (see [bodies](#ref-values-and-bodies)); a patch is one chunk per
structure that changed, with fresh structures inlined into the parent's ADD.

## Schema ops

```
schemaOp     := uvarint(fieldIndex << 2 | op2) value?
op2          := REPLACE 0 | DELETE 1 | ADD 2 | DELETE_AND_ADD 3
value        := <field type encoding> | refValue          -- absent for DELETE
```

Fields 0–31 fit one byte; a Schema may declare up to 64 fields (indexes 0..63).

## Keyed collections (Map / Set / Collection / Stream)

```
keyedOp      := u8 op uvarint(index) [string key] value?
op           := REPLACE 0 | DELETE 64 | ADD 128 | DELETE_AND_ADD 192 | CLEAR 10
```

Entries are addressed by a stable wire index (a monotonic counter per
collection). `MapSchema` sends the string key with every ADD-bit op and
addresses the entry by index afterwards; Set / Collection / Stream entries
carry no key. `CLEAR` is a lone byte, always the first op of its chunk: it
empties the collection and everything after it re-adds.

## Arrays

```
arrayChunk   := uvarint(refId) uvarint(byteLen) arrayOp*
arrayOp      := uvarint(arg * 16 + op) operands        -- arg: the op's first operand, 0 when it has none

op  name        arg              operands                weight
1   PUSH        count            value*                  count
2   INSERT      index            uvarint(count) value*   count
3   SET         index            value                   1
4   REMOVE      index            uvarint(count)          count
5   REVERSE     –                                        1
6   REORDER     len              uvarint(oldPos)*len     1          -- new[i] = old[oldPos[i]]
7   RESTATE     rev*2+identity   uvarint(count) value*   1 (positional) / 0 (identity)
8   ADD_REF     –                refValue                0          -- identity mode
9   DELETE_REF  refId                                    0          -- identity mode
10  CLEAR       –                                        1
11  BASE        baseSeq                                  0          -- see Revision
```

Array ops are an ordered **log**: the decoder replays them in place (append,
insert, index write, remove, reverse, permute). Values are the array's child
type (a primitive, or a `refValue` for Schema children). An op whose `arg`
is below 8 costs one byte.

### Revision

Every array carries a **revision**: the total weight of every op ever
applied to it. A snapshot of an array (a positional `RESTATE`, or an inline
body) carries the revision it was taken at.

The decoder keeps the revision per array. A chunk's ops apply from a
sequence number that starts at the client's own revision; a `BASE` op sets
it explicitly. The encoder sends `BASE` only for a tick in which a snapshot
of the array was taken (some client's revision lies inside the pending
range): otherwise every client sits at the revision the previous tick ended
on and the log simply resumes.

```
seq = rev                                      -- BASE baseSeq: seq = baseSeq
for each op:
    k = max(0, rev - seq)                      -- units already covered by a snapshot
    if k < weight: apply the op with its first k units skipped
    seq += weight
rev = max(rev, seq)
```

Partial application: `PUSH` / `INSERT` skip their first `k` values (an
`INSERT` then lands at `index + k`), `REMOVE` becomes `REMOVE(index,
count − k)`; weight-1 ops are all-or-nothing. A skipped value is still read
(and an inline body still merged). A positional `RESTATE` applies iff its
revision is newer than the client's and then sets the client's revision;
otherwise it is consumed without effect.

This is what lets a client that received `encodeAll` in the middle of a tick
apply exactly the ops recorded after its snapshot, with no per-element
identity checks and no duplicated elements.

### Identity mode

An array of Schema children under a `@view()` field (a *filtered* array) is
encoded per view as a **set**: `ADD_REF` / `DELETE_REF` by refId, a
`RESTATE` in identity form (`RESTATE` with arg 1: `uvarint(count) refValue*`),
and `CLEAR`. Positions are never sent — each client holds the elements it
was granted, in the order it received them. No `BASE` is sent and the
identity ops have weight 0.

## Ref values and bodies

```
refValue     := uvarint(refId * 4 + hasBody * 2 + hasTypeId) [uvarint typeId] [body]
```

- `hasTypeId` is set only when the instance is a registered subclass of the
  declared type.
- `hasBody` means the instance's contents follow inline. It is the encoder's
  choice; the decoder handles both.

```
body(Schema)   := mask values*               -- values in ascending field order, one per set mask bit
mask           := 7-bit groups, LEB128 shape: bit i of the presence set lives in group i/7, bit i%7;
                  only groups up to the highest set bit are written (empty instance = one 0x00 byte)
body(Map)      := uvarint(count) { uvarint(index) string(key) value }*
body(Set|Collection|Stream) := uvarint(count) { uvarint(index) value }*
body(Array)    := uvarint(rev*2) uvarint(count) value*          -- positional: the whole array at revision `rev`
                | uvarint(1) uvarint(count) refValue*           -- identity: the visible refs, merged
```

An array body is a `RESTATE` with the op nibble removed. When a body is
inlined for a view that was just bound to some elements of a filtered array
(`view.add(element)`), the identity body carries only those elements.

Ref-typed values inside a body are `refValue`s and may carry bodies
themselves, so a snapshot is one nested root chunk. A body is a **merge**:
`instance = refs.get(refId) ?? create(declared or typeId class)`, then the
masked fields / entries are set over whatever the instance already holds. A
positional array body is authoritative for the array (extra elements are
removed) and sets its revision; an identity body only adds unknown refs.

Worked example — `State { prims: Prims { str: "hi", num: 42 } }` full snapshot:

```
00          chunk refId 0 (root)
07          chunk length
02          field 0 (`prims`), op ADD            = 0 << 2 | 2
06          refValue: refId 1, hasBody            = 1 * 4 + 2
03          mask: fields 0 and 1 present
02 68 69    str = "hi"                            (uvarint 2, 'h', 'i')
2a          num = 42                              (positive fixint)
```

## Reflection handshake

```
handshake    := uvarint(6) chunk*        -- the Reflection schema encoded with this codec
```

A 5.x handshake always starts with byte `0x80`; a 6.x decoder rejects it
with an explicit error instead of desynchronizing.

## Encoder rules

The pass structure: a **shared** pass emits unfiltered fields of unfiltered
trees; a **view** pass per client emits `@view`-tagged fields and filtered
trees visible to that view, preceded by the `view.changes` drain
(visibility bootstrap). View encodes return `[shared, viewSlice]` — two
views into the shared buffer; a transport sends both (or `Encoder.concat`).

- **Chunks open lazily** on the first op that passes the filter and are
  closed by back-patching the length byte; lengths ≥ 128 move the chunk body
  up by the extra bytes.
- **Inline bodies** (`hasBody = 1`): snapshot passes inline every public
  tree on first reach; a patch inlines a fresh tree (`isNew`, queued this
  tick, same side of the filter split, visible) whose recorder holds nothing
  but plain ADDs — for arrays, a pure-PUSH log. Anything else emits its own
  chunk. An inlined tree is stamped so its own chunk is skipped for the rest
  of the pass.
- **Array log**: mutations are recorded in order with their values captured
  at record time. Same-tick coalescing: consecutive pushes extend one PUSH;
  a value pushed and removed (or overwritten) in the same tick never reaches
  the wire; adjacent single removals merge into one REMOVE; `sort` / `move`
  / `shuffle` record one REORDER (nothing when the order is unchanged);
  `clear` drops the pending log. Entries a mid-tick snapshot already
  delivered are never rewritten (`snapRev` watermark).
- **Streams** (`t.stream()`, `.stream()` collections): broadcast mode
  emits up to `maxPerTick` ADDs per stream after the main loop with the
  element's live body inline (`@unreliable` fields excluded); view mode
  drains per-view pending through `view.changes`.
- The **unreliable channel** (`encodeUnreliable`) emits Schema field ops
  only, same grammar, no bodies.

## Decoder rules

- **Chunk loop**: read `refId`, `len`; unknown refId → skip `len` bytes
  (warn); a definition mismatch inside a chunk (unknown field index) → skip
  to the chunk end; a chunk that does not consume exactly `len` bytes is
  resynchronized at its end. Under `decodeResync` any of these marks the
  payload damaged and the sweep is skipped, never deleting live data.
- **Refcounts**: increment on an ADD-bit op when the slot's value changed
  (or on a DELETE_AND_ADD self-reassign); DELETE-bit ops release the
  previous ref first; array REMOVE / CLEAR / positional truncation release
  each removed ref; a `DELETE_REF` for an unknown refId is ignored entirely;
  a collection replaced by a different instance releases the old one and
  enqueues `onRemove` for its entries but never decrements its children (GC
  does, so a shared child is not double-decremented).
- **Array revision gate**: see [Revision](#revision). A positional
  `RESTATE` over a populated array of Schema children is applied as a diff
  by identity (elements that left, elements that arrived, survivors that
  moved), never as a churn per slot.
- **Callbacks**: the `DataChange` for a slot is recorded *before* its inline
  body is decoded (preorder). A `listen()` registered from inside a callback
  fires immediately unless a later change for the same field is still
  pending in the batch. Callbacks fire once at the end of the decode, after
  the resync sweep, before GC.

## Callbacks

Array ops map onto the callback vocabulary (`OPERATION`): PUSH / INSERT →
`onAdd` per element; REMOVE / CLEAR → `onRemove` per element; SET → `onChange`
(primitive) or `onRemove` + `onAdd` + `onChange` (Schema child); REVERSE /
REORDER → `onChange` for every slot whose element changed, never `onAdd` /
`onRemove`; a positional RESTATE → the identity diff above.

## Porting a 5.x decoder to 6.x

Checklist for the other-language decoders (C#, Lua, Haxe, C++, Defold, …).
Every item is a hard break: a 6.x stream is not parseable by a 5.x decoder,
and the handshake rejects the mismatch instead of desynchronizing. Section
references point at the grammar above.

1. **Framing** ([message and chunks](#message-and-chunks)). 5.x announced a
   structure with the `SWITCH_TO_STRUCTURE` byte (255) followed by a msgpack
   refId, and recovered from an unknown refId or field by scanning for the
   next 255. 6.x wraps each structure in `uvarint(refId) uvarint(byteLen)`:
   skip exactly `byteLen` bytes on an unknown refId, skip to the chunk end
   on a definition mismatch. 255 is an ordinary byte now.
2. **Integers.** Every structural integer — refId, field index, wire index,
   count, length, type id, revision, array op operand — is unsigned LEB128,
   not a msgpack number. Field *values* keep their declared encoding; the
   dynamic `number` type is unchanged (msgpack-shaped).
3. **Strings** ([primitives](#primitives)): `uvarint(utf8Len) utf8` replaces
   the msgpack `str` family; `null` / `undefined` ride as `""`.
4. **Schema field ops** ([schema ops](#schema-ops)): `uvarint(fieldIndex << 2
   | op2)` with `op2` REPLACE 0 / DELETE 1 / ADD 2 / DELETE_AND_ADD 3,
   instead of the 5.x byte `op | fieldIndex` (op in bits 6–7, index in bits
   0–5). Up to 64 fields (5.x reserved index 63 for the 255 marker).
5. **Type ids** ([ref values](#ref-values-and-bodies)): the 5.x `TYPE_ID`
   marker (213) + msgpack id before a ref is gone. A ref is
   `uvarint(refId * 4 + hasBody * 2 + hasTypeId)`, followed by
   `uvarint(typeId)` when the flag is set.
6. **Inline bodies** (new). A ref with `hasBody` carries the instance's
   contents right after the header: Schema presence mask (7-bit groups) +
   values in ascending field order, or a map / set / array body. Bodies
   nest. A decoder resolves `refs.get(refId) ?? create(type)` and merges the
   body into it; a positional array body is authoritative (truncates) and
   sets the array's revision; an identity array body only adds unknown
   refs. Full syncs are one root chunk with nested bodies, so the 5.x
   "structure by structure" full-sync walk no longer exists.
7. **Keyed collections** ([keyed collections](#keyed-collections-map--set--collection--stream)):
   op byte (values unchanged: ADD 128, REPLACE 0, DELETE 64, DELETE_AND_ADD
   192, CLEAR 10) then `uvarint(index)`, then for `MapSchema` the key string
   on every ADD-bit op. `CLEAR` is a lone byte, always the first op of its
   chunk. Set / Collection / Stream carry no key.
8. **Arrays** ([arrays](#arrays)): an entirely new grammar. The 5.x
   index-addressed ADD / REPLACE / DELETE and the ops `MOVE` (32),
   `DELETE_AND_MOVE` (96), `MOVE_AND_ADD` (160), `ADD_BY_REFID` (129),
   `DELETE_BY_REFID` (33) are gone. A 6.x array chunk is an ordered op log
   — `uvarint(arg * 16 + op)` per op: PUSH, INSERT, SET, REMOVE, REVERSE,
   REORDER, RESTATE, ADD_REF, DELETE_REF, CLEAR, BASE — replayed in place.
   The decoder keeps a **revision per array** and applies the gate in
   [Revision](#revision) (partial application of PUSH / INSERT / REMOVE, a
   positional RESTATE only when newer). Arrays of Schema children under a
   `@view()` field arrive in [identity mode](#identity-mode): ADD_REF /
   DELETE_REF / identity RESTATE, elements kept in receive order. There is
   no end-of-decode compaction step; the decoded array is a plain array.
9. **Reflection handshake** ([handshake](#reflection-handshake)): the
   payload starts with `uvarint(6)`; a 5.x handshake's first byte is
   `>= 0x80`. Reject the other version with an explicit error.
10. **Refcounts** ([decoder rules](#decoder-rules)): same increment /
    release rules as 5.x for Schema fields and keyed entries; arrays release
    each element removed by REMOVE / CLEAR / positional truncation / SET
    over a ref; a `DELETE_REF` for an unknown refId is ignored entirely;
    replacing a collection releases the old instance and reports `onRemove`
    for its entries without decrementing its children.
11. **Callbacks** ([callbacks](#callbacks)): the `DataChange` vocabulary is
    unchanged (ADD / REPLACE / DELETE / DELETE_AND_ADD); array ops map onto
    it per the table, reorders fire `onChange` per moved slot (never
    `onAdd` / `onRemove`), a positional RESTATE over Schema children is
    reported as a diff by identity, and the `DataChange` for a slot is
    recorded before its inline body is decoded (preorder).
12. **Resync** (`decodeResync`): unchanged contract, but any chunk that
    cannot be decoded exactly marks the payload damaged and skips the sweep.
13. **Fixtures**: `test-external/generate-*.ts` still emit 5.x fixtures;
    regenerate them from the 6.x encoder once the decoder is ported.
