# v6 wire format — proof of concept

`Encoder6` / `Decoder6` / `Reflection6`: an alternative wire format for the
same `ChangeTree` / `Root` / `StateView` bookkeeping the shipping v5 codec
uses. Only the bytes differ. Nothing here is wired into `Encoder` /
`Decoder`; it exists to answer "is a 6.0 format worth it?" with numbers
(`bench/v6-results.md`).

Contents: [why](#why-revisit-the-format) · [format](#the-wire-format) ·
[encoder rules](#encoder-rules) · [decoder rules](#decoder-rules) ·
[decisions](#decisions-and-alternatives) · [results](#results) ·
[scope / verification / findings / follow-ups](#scope-of-the-poc).

## Why revisit the format

The v5 format has been stable since 3.0: an op stream grouped by
`SWITCH_TO_STRUCTURE (255) + refId`, one `fieldIndex | op` byte per Schema
field, msgpack-style prefixed integers for refIds / indexes / `number`, and a
child instance introduced by refId in its parent's op with its own fields
emitted later under its own switch. Measured on the canonical bench shapes:

| observation | measurement |
|---|---|
| A snapshot is mostly framing. | bloat `encodeAll`, 1000 entities: 68 982 B = switch headers 11 622 + field-op bytes 18 617 + refIds-in-parent 8 621 + map keys 9 000 + **values 21 122** → 56 % framing (size model reproduced the count exactly). |
| A new instance pays its refId twice. | once as the parent's field value, once in `255 + refId`; refIds ≥ 256 cost 3 bytes (`0xcd`) and are never recycled. |
| Byte `255` is the only framing byte. | `SWITCH_TO_STRUCTURE = DELETE_AND_ADD \| 63` forces `MAX_FIELDS = 63`; `TYPE_ID = 213 = DELETE_AND_ADD \| 21` is misread as a type marker by `getInstanceType`'s peek on any Schema with ≥ 22 fields; an unknown refId is recovered by scanning for the next `255` (`skipCurrentStructure`), which value bytes can fool. |
| Per-view encoding scales with dirty trees, not visible ones. | `encodeView` re-walks the whole `root.changes` list per view and `concatBytes` copies the shared region per client: 500 moving entities → 6.4–7.9 µs per view to emit an 8-byte view slice; v5 profile: `_encodeChannel` 24 %, `concatBytes` 12 % of `stateview/views/v10`. |
| Decoder time goes to structure switching. | v5 profile: the `255` peek + `refs.get` per switch = 22.7 % self time of `decoder/tick`. |

Use cases to serve: full snapshot (`encodeAll`), resync snapshot
(`encodeAll` + `decodeResync`), patch (`encode`), per-view patch
(`encodeView`).

## The wire format

### Primitives

| item | encoding |
|---|---|
| `uvarint` | unsigned LEB128: 7 bits per byte, low group first, high bit = continuation. 1 byte < 128, 2 bytes < 16 384, 3 bytes < 2 097 152. Used for every structural integer: refIds, field/entry indexes, counts, lengths, type ids. |
| `string` | `uvarint(utf8ByteLength) utf8Bytes`. `null` / `undefined` ride as `""` (as v5). |
| fixed-width types | unchanged from v5: `int8…int64`, `uint8…uint64`, `float32`, `float64`, `bigint64`, `biguint64`, `boolean` — little-endian, no tag. |
| `number` (dynamic) | unchanged from v5's msgpack-derived scheme: positive fixint `0x00–0x7f`, negative fixint `0xe0–0xff`, `0xcc/0xcd/0xce/0xcf` uint8/16/32/64, `0xd0–0xd3` int8/16/32/64, `0xca` float32 (chosen when `\|f32(v) − v\| < 1e-4`), `0xcb` float64. The writer is a byte-identical rewrite (`number6`), fuzzed against `encode.number`. |
| quantized | unchanged (raw `uint8/16/32` per the field's `bits`). |

### Message

```
message      := chunk*
chunk        := uvarint(refId) uvarint(byteLen) ops[byteLen]
```

A message is a sequence of chunks, each addressing one structure by refId
and carrying exactly `byteLen` bytes of ops for it. There is no reserved byte:
a decoder that does not know `refId` skips `byteLen` bytes and continues.
Which op grammar applies is decided by the structure's kind (Schema, Map,
Array, Set/Collection/Stream), as in v5.

### Schema ops

```
schemaOp     := uvarint(fieldIndex << 2 | op2) value?
op2          := REPLACE 0 | DELETE 1 | ADD 2 | DELETE_AND_ADD 3     -- the v5 OPERATION byte >>> 6
value        := <field type encoding> | refValue                     -- absent for DELETE
```

Fields 0–31 fit one byte; no upper bound on field count (v5: 63).

### Collection ops

```
collectionOp := u8 op, uvarint(operand), value?
```

`op` is the v5 `OPERATION` byte verbatim; `operand` is the wire index, or a
refId for the `*_BY_REFID` ops:

| op | byte | operand | value |
|---|---|---|---|
| REPLACE | 0 | index | value |
| ADD | 128 | index | Map: `string(key)` then value; others: value |
| DELETE | 64 | index | — |
| DELETE_AND_ADD | 192 | index | as ADD |
| CLEAR | 10 | — | — |
| REVERSE (array) | 15 | — | — |
| MOVE (array) | 32 | index | refValue (never a body) |
| DELETE_AND_MOVE (array) | 96 | index | refValue |
| MOVE_AND_ADD (array) | 160 | index | value |
| DELETE_BY_REFID (array) | 33 | refId | — |
| ADD_BY_REFID (array) | 129 | — | refValue (its refId *is* the operand — v5 wrote it twice) |

MapSchema sends the string key on every ADD-bit op and addresses the entry
by its journal index afterwards, exactly as v5.

### Ref values

```
refValue     := uvarint(refId * 4 + hasBody * 2 + hasTypeId) [uvarint typeId] [body]
```

- `hasTypeId` is set only when the instance is a registered subclass of the
  declared type (v5: the `213` marker byte).
- `hasBody` means the instance's contents follow inline (see bodies). It is
  the encoder's choice; the decoder handles both.

### Bodies

```
body(Schema) := mask values*            -- values in ascending field order, one per set mask bit
mask         := 7-bit groups, LEB128 shape: bit i of the presence set lives in group i/7, bit i%7;
                only groups up to the highest set bit are written (empty instance = one 0x00 byte)
body(Map)    := uvarint(count) { uvarint(index) string(key) value }*
body(Array)  := uvarint(count) value*    -- no slot: see "array bodies" under decoder rules
body(Set|Collection|Stream) := uvarint(count) { uvarint(index) value }*
```

Ref-typed values inside a body are `refValue`s and may carry bodies
themselves, so a snapshot is one nested root chunk.

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

v5 emits the same state as `80 01 | ff 01 80 a2 68 69 81 2a` (11 bytes): the
child's refId twice, a switch byte, and an op byte per field.

### Reflection handshake

```
Reflection6  := uvarint(6) + Reflection schema encoded with the v6 codec
```

A v5 handshake always starts with byte `0x80` (root field 0 `types`, op ADD),
so `Reflection.decode` reads a leading byte `< 0x80` as a protocol version and
dispatches to `Reflection.codecs[version]`; `Reflection6` registers itself
under 6. The type table itself is unchanged.

## Encoder rules

The pass structure is v5's: a **shared** pass emits unfiltered fields of
unfiltered trees; a **view** pass per client emits `@view`-tagged fields and
filtered trees visible to that view, preceded by the `view.changes` drain
(visibility bootstrap). What differs is emission:

- **Chunks open lazily** on the first op that passes the filter and are
  closed by back-patching the length byte; lengths ≥ 128 move the chunk body
  up by the extra bytes (`copyWithin`), unless that would overrun the buffer,
  in which case the overflow check triggers the usual resize-and-re-encode.
- **When an ADD of a ref-typed value inlines a body** (`hasBody = 1`):
  - snapshot (`encodeAll`): on the first reach of every public tree; a shared
    instance reached again gets `hasBody = 0` (visit stamp);
  - view snapshot (`encodeAllView`): filtered, visible trees on first reach
    (public trees keep their own chunk, as v5's structural walk);
  - patch (`encode`): the child tree is fresh (`isNew`), queued this tick on
    the same side of the filter split, visible, and its recorder holds
    **nothing but plain ADDs**. Any DELETE / DELETE_AND_ADD / REPLACE / MOVE
    falls back to the child's own chunk exactly as v5 emits it;
  - drain (`encodeView`): the child's `view.changes` entry exists and is all
    ADDs → body from that entry (already tag-filtered by `StateView.add`);
    no entry → the patch rule; an entry with a DELETE drains on its own.
  A tree whose body was inlined is stamped so its own chunk is skipped for
  the rest of the pass and later references to it write `hasBody = 0`.
- **Body contents**: snapshot bodies walk the live structure through the pass
  filter (`forEachLive` rule: declared, not `@patchOnly` / `@deprecated`,
  non-null); patch bodies take the ADD-bit fields of the recorder (so
  `@fullStateOnly` / paused fields stay out, as in v5 patches); drain bodies
  take the entry's indexes.
- **Filtered Schema-child arrays** keep v5's identity ops (`ADD_BY_REFID` /
  `DELETE_BY_REFID`, no MOVE) so per-view subsets never depend on positions.
- **`encodeView` / `encodeAllView` return `[shared, viewSlice]`**, two views
  into the shared buffer, instead of a concatenated copy per client. The
  per-tick filtered pass walks only the trees with filtered dirty state
  (collected once per tick), and a tree's chunk that contains no ref values is
  encoded once and memcpy'd into every later view with the same custom-tag
  set — enabled only when more than one view is registered, because the copy
  costs more than it saves for a single client.

## Decoder rules

- **Chunk loop**: read `refId`, `len`; unknown refId → skip `len` bytes
  (warn); a definition mismatch inside a chunk (unknown field index) → skip
  to the chunk end; a chunk that does not consume exactly `len` bytes is
  resynchronized at its end. Under `decodeResync` any of these marks the
  payload damaged and the sweep is skipped, never deleting live data.
- **A body is a merge**: `instance = refs.get(refId) ?? create(declared or
  typeId class)`, then set the masked fields (or entries) over whatever the
  instance already holds. There is no "new versus existing" branch, which is
  what makes bodies safe for a client that already received the instance
  through a mid-tick `encodeAll`.
- **Refcounts** follow v5's `decodeValue` rules unchanged: increment on an
  ADD-bit op when the slot's value changed (or on a DELETE_AND_ADD
  self-reassign); DELETE-bit ops release the previous ref first; a collection
  replaced by a different instance releases the old one and enqueues
  `onRemove` for its entries but never decrements its children (GC does, so a
  shared child is not double-decremented).
- **Array bodies** carry no slot. Primitive children are positional
  (`items[i] = v`, REPLACE semantics). Schema children: an empty client array
  fills positionally; `decodeResync` writes positionally (server order is
  authoritative, as v5's snapshot ADDs); a non-empty array outside resync
  places by identity (`indexOf` or append) — the `ADD_BY_REFID` rule —
  because a filtered client may already hold some of the elements at other
  positions, where positional writes would leak refcounts.
- **Callbacks**: the `DataChange` for a slot is recorded *before* its inline
  body is decoded (preorder), so `listen()` registered inside an `onAdd`
  still sees the field changes that follow; callbacks fire once at the end of
  the decode, after `$onDecodeEnd` and the resync sweep, before GC, as v5.
  `[shared, viewSlice]` pairs decode as one session. `Decoder6 extends
  Decoder` so `Callbacks.get()`, `ReferenceTracker` and the resync helpers are
  reused as they are.
- **Robustness tests**: `test/v6/differential-misc.test.ts` #15 covers an
  unknown-refId chunk between valid chunks, a truncated length, and an unknown
  field index.

## Decisions and alternatives

**Length-prefixed chunks instead of `255 + refId`.** Same byte cost
(`refId + len` ≈ `255 + refId`; one byte less for refIds 256–16 383), exact
skipping of unknown refIds instead of a heuristic scan, no reserved byte (so
no 63-field cap and no `213` collision), and a chunk becomes a memcpy unit
for per-view encoding. Cost: the length is back-patched, which for the ≥ 128
case moves the chunk body — one memmove of the root chunk per snapshot.
Rejected alternative: an op count instead of a length (cannot skip without
parsing).

**Inline bodies with a presence mask.** A new instance pays neither the
second refId nor a switch byte nor an op byte per field: −43 % on the bloat
snapshot, −29 % on a join with a view, −43 % on entity churn patches. The
mask is LEB128-shaped (7 bits per byte, only up to the highest set bit) rather
than a fixed `ceil(N/8)` bytes so it is self-delimiting (a peer with more
fields is detected as a mismatch instead of a desync) and a sparse instance
of a wide schema costs one byte. Rejected alternative: a bitmask-diff format
for *patches* too — it would drop the ADD/DELETE distinction that array
insert semantics and `onRemove` rely on, for a ~1-byte gain on ticks that
change ≥ 2 fields of a small struct.

**"Fresh and pure-ADD" as the inline rule for patches.** The first cut used
`isNew` alone and failed the differential harness: a client that joins
mid-tick receives `encodeAll` before the tick's construction ADDs are flushed,
so "new to the encoder" is not "unseen by every client". A body that merges is
still correct there; a body that would have to express a DELETE is not — so
any non-ADD op falls back to v5's own chunk. The same scenario exposed a v5
bug (an ADD over an occupied array slot after a mid-tick join inserts instead
of replacing), see findings.

**Bodies sourced from `view.changes` entries in the drain.** The first cut
used the live structure through the view filter and re-sent a custom-tagged
field after `view.remove` + default-tag `view.add` (the tag bit survives the
remove). v5 drains exactly the entry `StateView.add` wrote, which already
applied the tag rules; v6 now does the same.

**LEB128 for structural integers; msgpack `number` kept.** refIds grow
monotonically and are never recycled (a stable identity for reconnects), so
long-lived rooms live above 255 where LEB128 is a byte shorter; the decode is
a loop instead of a 12-branch prefix chain. The dynamic `number` stays
msgpack-shaped: a zigzag-LEB integer scheme wins for 256–8191 and loses for
64–127, so it is data-dependent, and replacing the lossy `1e-4` float32
heuristic is a product decision (correctness versus 9-byte floats) rather than
a format one. Typed fields (`float32`, `int16`, …) are untouched and remain
the way to get compact payloads.

**Schema ops as `uvarint(index << 2 | op2)`; collection ops unchanged.**
Same one byte as v5 for fields 0–31, unbounded above, no collision with
framing. Collection ops keep v5's byte vocabulary because the array ops
(`MOVE`, `DELETE_AND_MOVE`, `MOVE_AND_ADD`, the `*_BY_REFID` pair) encode
carefully tested semantics; the only change is that `ADD_BY_REFID` carries
its refId once.

**Array-body placement by receiver state rather than one wire rule.** The
alternatives were "always identity" (loses v5's server-order restoration on
resync for unfiltered clients) or a slot per element (+1 byte each, and
positions are meaningless for filtered clients anyway). Positional on empty /
resync, identity otherwise, reproduces v5 behaviour in every differential
script; the fallback if that ever disagrees is `hasBody = 0` for filtered
Schema-child arrays with `ADD_BY_REFID` ops, which the encoder already emits
per tick.

**`[shared, view]` slices and the per-view chunk cache.** The concat was 12 %
of the per-view tick and the re-walk of every dirty tree per view 24 %; with
length-prefixed chunks the filtered ops of a tree can be encoded once and
memcpy'd. The cache is gated on `activeViews.size > 1`: with one client it
was +20 % (copying into the scratch buffer for nobody); gated, one client is
flat and 50–100 clients are −43…−49 %.

**Decoder-side bodies decoded in preorder.** Required by the callback
strategy: a `listen()` registered inside `onAdd` suppresses its immediate
call while dispatching and relies on the field's change appearing later in
the batch. The one behaviour difference this creates (a shared instance bound
twice in the same tick) is listed under findings.

**Not changed, on purpose.** refIds are still not recycled (reconnect
safety); the unreliable channel, streams, `InputEncoder` reuse the same op
grammar and are simply not ported in the PoC; the resync sweep is untouched
because a nested snapshot is still "dense plain ADDs" (each collection body
lists exactly its live entries).

**Performance decisions (from V8 profiles, `bench/v6-results.md`).** The
first implementation matched v5 per field and lost per chunk. The profile
showed the per-field emitter was never inlined: `ChangeTree.forEachWithCtx`'s
callback site is shared by every recorder consumer and is megamorphic, so v6
walks the recorder storage itself (`dirtyLow/High`, packed op bytes,
`collDirty` + pure-op interleave — `test/v6/recorder-walk.test.ts` keeps the
two walks in agreement); the pass and tree state live on one frame object;
`number6` is a byte-identical leaner number writer; and the per-tree +
per-field chain was trimmed to V8's cumulative inlining budget (cold tails out
of line; a small helper called from `encode()` itself was enough to push
`enterFrame` out of the inline set).

## Results

N = 20 isolated samples per row, p < .001 on every time row
(`bench/v6-results.md` has the full table):

| use case | time | bytes |
|---|---:|---:|
| full snapshot, 1000 / 2000 / 5000 entities | −43 / −42 / −41 % | −43 / −41 / −39 % |
| join with a view · resync full / churn | −34 % · −13 / −12 % | −29 % · −43 / −43 % |
| patch, 10 % / 100 % of entities moving | −13…−19 % / −15 % | −1…−4 % / −6 % |
| entity churn (10 removed + 10 added per cycle) | +1.5 % | −43 % |
| decoder bootstrap / tick / churn · callbacks | −11 / −5 / −6 % · −1.6 % | — |
| per-view tick, 1 / 10 / 50 / 100 views | −8 / −21 / −43 / −49 % | −7…−8 % |

Patches are value-dominated (10 of ~14 bytes per moved entity are the two
float32 payloads), so their byte gain is the refId width; snapshots, joins,
churn and many-client views are where the format changes pay.

A fresh-session A/B of the shipping v5 path (pristine `e7b3d07` vs this tree,
46 units, N = 20, ABBA) found no regression at the 2 % / p < 0.05 threshold
and identical bytes everywhere. The one cost on the shipping side is bundle
size: `src/index.ts` re-exports `src/v6`, +74 KB (+15 %) on `build/index.mjs`
— a subpath entry (`@colyseus/schema/v6`) before anything ships.

## Scope of the PoC

Covered: `Schema`, `MapSchema`, `ArraySchema` (primitive and Schema children),
`@view` tags + `StateView` add/remove, polymorphism, instance sharing,
`encodeAll` / `encodeAllView` / `encode` / `encodeView` / `decodeResync`,
the `Callbacks` strategy. `SetSchema` / `CollectionSchema` encode and decode
through the generic indexed path but are untested; `StreamSchema` emission,
the unreliable channel, quantized collection children and `InputEncoder` are
not ported (the format does not preclude them).

## Verification

- `test/v6/differential*.test.ts` — twin v5/v6 states run the same scripts;
  after every tick both sides must agree on server JSON, client JSON, encoder
  and decoder refcounts, decoder `refs`, the multiset of callback events, and
  emit no warnings (`test/v6/harness.ts`).
- `test/v6/recorder-walk.test.ts` — random op mixes on packed (≤ 8 fields)
  and wide Schemas and on collections with `CLEAR` / `REVERSE`, decoded
  identically under both codecs; guards the direct recorder walk.
- `npm run test:v6` — the existing suite (Schema, Map, Array, sharing,
  inheritance, StateView, callbacks, resync, …) against the v6 codec via the
  `SCHEMA_CODEC=v6` switch in `test/Schema.ts`. Cases skipped under v6 are
  marked `onlyCodec("v5", reason)`: v5 byte-count assertions, a v5-only
  standalone child decode, StreamSchema, and one callback-ordering case (see
  below).

## Findings while porting

- **v5 array insert on a mid-tick join.** A client that receives `encodeAll`
  before the tick's construction ADDs are flushed, and then a patch where an
  ADD-recorded array slot changed value, gets an *insert* (`[7, 2, 1, 2]`)
  instead of a replace — `ADD` at an occupied index means insert since 5.0.
  v6 bodies merge, so the client matches the server
  (`test/v6/differential-misc.test.ts`, "mid-tick join + array slot write").
- **Callback order for a shared instance bound twice in one tick.** v6 emits
  a body in preorder (binding → fields), so a `listen()` registered through the
  *second* binding attaches after the field change was dispatched and does not
  see the initial value; v5 happened to deliver both bindings before the body.
  The same gap exists in v5 whenever the second binding lands in a later tick.
  Fixing it belongs to the callbacks strategy (fire the deferred `listen`
  immediately when no later change for that field is pending in the batch).
- **`StateView.test.ts` "view.add(TAG) should not encode ADD twice"** only
  yields 4 bytes because the test creates a second `Encoder` on the same state
  (re-rooting it); with one encoder both codecs emit the field twice (drain +
  per-tick pass) — the known bootstrap double-emission.
- `encode()` returns a view into the shared buffer in both codecs; a test that
  keeps a patch across a later `encodeAll` must `.slice()` it.

## Follow-ups the format leaves open

- Fold the bootstrap double emission (drain + per-tick filtered pass).
- Implicit sequential refIds for fresh instances in snapshots (≈ −15 %).
- `uvarint(bodyLen)` per body for exact recovery inside bodies / lazy decode
  (≈ +2.5 % bytes).
- `number` encoding (zigzag-LEB vs msgpack prefixes; exact-f32 check instead
  of the lossy `1e-4` heuristic).
- Port Set/Collection/Stream bodies, the unreliable channel, `InputEncoder`.
- Ship v6 from a subpath entry instead of the main bundle.
