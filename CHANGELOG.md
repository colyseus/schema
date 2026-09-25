# Changelog

All notable changes to this project are documented in this file. The
format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [6.0.0-alpha.0]

### Changed (breaking)

- **Chunk header carries a refId delta** (`SPEC.md`, "Message and chunks"):
  `uvarint(refId * 2 + 1)` for the first chunk of a slice, then
  `uvarint(zigzag(refId − prevRefId) * 2)`. Dirty structures come out in
  change order, which mostly follows allocation order, so the header stays one
  byte long after absolute refIds pass 127: −3.6 % on a 5000-entity patch,
  −6 % on the RPG / shard patches. The first chunk of every slice is
  self-describing, so `[shared, view]` decodes concatenated or separately.
- **Same-shape runs**: the length prefix is `uvarint(byteLen * 2 + flag)`;
  with the flag set the chunk is a run — consecutive dirty Schemas of one
  class whose dirty fields are the same primitives (all writes) share one
  header, class id and field mask, each member costing its refId delta plus
  its values. On a room of same-class entities updating the same fields per
  tick this is about −19 % (5000-entity patch, area-of-interest view slices,
  RPG hero patch). A run never carries ref fields, DELETEs, `@view`-tagged
  fields or fields past index 31; those structures keep their own chunk.
- **Encoder / decoder hot paths** (`bench/realworld-results.md`): the per-view
  pass walks per-view work lists built once per tick from the visibility
  bitmaps instead of scanning every dirty filtered tree for every client
  (area-of-interest rooms −24…−43 %, 500 owner-only clients −25 %); idle views
  skip the pass and share the tick's shared slice; the per-tick scratch arrays
  keep their backing store instead of being truncated (no GC churn per view); the decoder keeps a per-ref
  record on the ref's tree and writes primitive slots straight into the
  backing array instead of a dynamic `ref[name]` access (a 5000-entity patch
  decodes 5× faster); generated setters reach the change tree through one
  load; the reflection handshake reuses one buffer instead of allocating
  `Encoder.BUFFER_SIZE` per client join (`new Encoder(state, root,
  bufferSize)`). The internal `static [$track]` hook is no longer consulted by generated
  setters — override `ChangeTree.change` semantics through `markDirty` /
  `pause` instead.
- **Round-2 hot-path fixes** (`bench/realworld-results.md`, "Round 2"): the
  encoder no longer truncates its body scratch arrays per tick (one-field
  patches −30 %, at parity with 5.x); the cross-view chunk cache is keyed
  per (tree, tag key) so views with different `@view(tag)` sets share
  encoded chunks (`stateview/tags` −46 %); `ArraySchema` search and callback
  builtins run monomorphic loops (`indexOf` −27 %, `forEach` / `map` /
  `filter` −7…−10 %); strings are written in one pass and long ones through
  `TextEncoder` / `TextDecoder` when available (string-heavy patches −22 %).
  Lone surrogates now encode as U+FFFD on every path (the length prefix and
  body used to disagree for ill-formed strings); well-formed strings are
  byte-identical. `decodeInfo` lives on `UntrackedChangeTree` and is added
  lazily to a tracked root that a `Decoder` decodes into.
- **Wire format 6** (see `SPEC.md`): length-prefixed chunks
  (`uvarint(refId) uvarint(len) ops`) replace the `255 + refId` switch byte,
  fresh instances ride inline as bodies of the parent's ADD, every structural
  integer is a LEB128 varint, strings are `uvarint(len) + utf8`. A 5.x client
  is rejected at the reflection handshake. Snapshots are ~40 % smaller and
  ~40 % faster to encode; patches ~15 % faster (`bench/v6-results.md`).
- **`ArraySchema` extends `Array`.** `Array.isArray(arr)` is true; `map` /
  `filter` / `slice` / `concat` / `flat` return plain arrays
  (`ArraySchema[Symbol.species] === Array`); `fill`, `copyWithin`, `flat`,
  `flatMap` work. Index writes are tracked through a `set`-only Proxy on the
  encoder side; decoder-side instances have no Proxy at all. Writes past the
  end append (no holes); `delete arr[i]` removes; growing `length` is ignored.
  V8 runs `Array.prototype` builtins on a subclass instance through their
  generic path, so `ArraySchema` overrides the common ones (`push`, `pop`,
  `shift`, `unshift`, `splice`, `sort`, `reverse`, `forEach`, `map`,
  `filter`, `find`, `findIndex`, `some`, `every`, `reduce`, `indexOf`,
  `lastIndexOf`, `includes`, `slice`, `at`) with index loops that are as
  fast as on a plain array or faster, and `for…of` / `values` / `keys` /
  `entries` iterate the raw array through a small iterator (about 3 ns per
  element). What remains costly is a read through the encoder-side Proxy
  itself: `arr[i]` costs about 70 ns there even without a `get` trap (5.x
  paid twice that through its `get` trap), so walk a large array on the
  server with `forEach`, `for…of` or `toArray()` rather than an index loop.
  Spread and `Array.from` remain about 15× slower than on a plain array.
- **Array wire model**: an ordered op log (PUSH / INSERT / SET / REMOVE /
  REVERSE / REORDER / RESTATE / CLEAR) with a per-array revision, so a client
  that joined mid-tick applies exactly the ops recorded after its snapshot.
  `sort()` / `move()` / `shuffle()` emit one REORDER (nothing when the order
  is unchanged) and fire `onChange` for moved slots, never `onAdd` /
  `onRemove`; a value pushed and removed in the same tick never reaches the
  wire. Arrays of Schema children under `@view()` keep identity ops
  (order not synced per view). Every array op is one varint carrying its
  first operand (`uvarint(arg * 16 + op)`): an index write costs
  `refId len op value`, four bytes for small values. The revision base is
  sent only in a tick that snapshotted the array (`BASE` op); otherwise the
  log resumes from the client's own revision.
- **Keyed wire model** (Map / Set / Collection / Stream): every op is one
  varint carrying its index, `uvarint(index * 4 + op)` (REPLACE 0, DELETE 1,
  ADD 2, CLEAR 3), instead of an op byte followed by the index. A REPLACE
  or DELETE on one of the first 32 entries is one byte (two below index
  8192); four deletes on a map cost six bytes on the wire (chunk header
  included). `DELETE_AND_ADD` no longer rides the keyed wire: an ADD onto
  an occupied index is the replacement, and the decoder releases the
  previous value and still reports `onRemove` + `onAdd`. Full-sync map
  bodies stream straight from the map (no scratch copy).
- **Typed map keys.** `@type({ map: X, key: "number" })` and
  `t.map(X, { key: "number" })` declare a `MapSchema<X, number>`: keys are
  JS numbers on both sides, ride the wire as a dynamic number (or the
  fixed-width `int8…uint64` / `float32` / `float64` type when one of those
  is declared as the key type) only on ADD-bit ops, and reach `onAdd` /
  `onRemove` / `onChange` as numbers. `"string"` stays the default and its
  wire bytes, metadata and codegen output are unchanged. A `MapSchema`
  populated before it is attached to a typed field is re-keyed on attach.
  `Reflection` carries the key type (`ReflectionField.keyType`, absent for
  string keys); `schema-codegen` emits it for every target. Declaring `key`
  on a non-map field, or an unknown key type, throws at declaration time.
- Binding an element of a filtered array to a view (`view.add(element)`)
  inlines that element only into the parent's re-binding; the rest of the
  array is not re-sent.
- Reorders and `RESTATE` snapshots over a populated array of Schema children
  report the elements that actually left / arrived, not a churn per slot.
- A `listen()` registered from inside a callback fires immediately unless a
  later change for that field is pending in the same batch (a shared
  instance bound twice in one tick now notifies both bindings).
- `Metadata.MAX_FIELDS` is 64 (indexes 0..63).
- `SPEC.md` documents wire format 6 and ends with a porting checklist for
  the other-language decoders (C#, Lua, Haxe, C++, Defold): framing,
  LEB128 integers, strings, field ops, type ids, inline bodies, keyed and
  array grammars, handshake, refcounts, callbacks.
- `ArraySchema` stays an `Array` subclass after a three-way comparison with
  v5 and a 5.x-style internal-array build (`bench/array-impl-comparison.md`);
  the alternative implementation was removed afterwards (git history,
  `16ff6be`).
- `encodeView` / `encodeAllView` / `encodeUnreliableView` return
  `[shared, viewSlice]`; `Decoder.decode` accepts the pair (or a single
  buffer). `Encoder.concat(parts)` joins them for single-buffer transports.
- `CollectionSchema` is deprecated (a `SetSchema` allowing duplicates; warns
  once). `SetSchema` gained O(1) `has` / `delete`.
- Removed: `MapSchema.$indexes` / `_collectionIndexes` (use `keyByIndex` /
  `indexByKey`), `MapJournal`, `CollectionChangeRecorder`, `clone(isDecoding)`
  (`clone()` only), the `$encoder` / `$decoder` statics, `SWITCH_TO_STRUCTURE`,
  `TYPE_ID`, `MOVE` / `DELETE_AND_MOVE` / `MOVE_AND_ADD` / `ADD_BY_REFID` /
  `DELETE_BY_REFID`, `decode.stringCheck`, and the `Encoder6` / `Decoder6` /
  `Reflection6` proof-of-concept exports (now the codec itself).
- `Reflection.encode` output starts with the protocol version byte; decode
  it with `Reflection.decode`, or skip the first byte for a raw `Decoder`.
- The other-language SDK decoders (C#, Lua, Haxe, …) and the fixture
  generators in `test-external/` still speak the 5.x format and need a port.
- **`$changes` and `$refId` are no longer own properties of an instance**
  (`bench/v6-results.md`, "Construction and attach"). Both cost an
  `Object.defineProperty` runtime call per instance — 22 % of a bulk-ADD
  workload, the `$refId` one a reconfigure of an already-declared field. The
  refId now lives on the ChangeTree (`tree.refId`) and the tree in a private
  slot; `instance[$changes]` / `instance[$refId]` keep working through
  non-enumerable prototype accessors on `Schema`, every collection, and any
  external class passed to `Metadata.setFields`. Code that looked for them with
  `Object.getOwnPropertySymbols` / `hasOwnProperty` no longer finds them
  (`ArraySchema` keeps an own `$changes`: its public identity is a Proxy).
  Building a tree of instances is −32 %, attaching it to the state −40 %, a
  full-state decode −36…−48 %, with no change to the wire bytes.
- **`decoder.root.refs` and `encoder.root.changeTrees` are `RefTable`s**
  (`src/RefTable.ts`, exported), an array-backed `refId → value` table with
  the read surface of a `Map<number, V>` (`get` / `has` / `size` / `keys` /
  `values` / `entries` / `forEach` / iteration, in ascending refId order) — it
  is not `instanceof Map`. `refs` was a `Map`: the hash probe per decoded chunk
  was 22…27 % of a steady decode tick (`decoder/tick` −30 %, large-patch decode
  −8…−10 %, `callbacks/density` −10…−21 %). `changeTrees` was a plain object
  indexed by refId — use `changeTrees.get(refId)` and `for (const [refId, tree]
  of changeTrees)` instead of index access / `for…in`: its store and `delete`
  were 14 % of attach / detach churn (`encoder/map-churn` −25…−29 %,
  `encoder/entity-churn` −22 %, map add + delete −31…−34 %) and a push-2000 /
  pop-2000 array tick fell off a dictionary-mode cliff (−99 %). Memory follows
  the live refs, not the highest refId: emptied pages are released.
- **`encoder.root.refCount` is a `RefTable` and holds attached instances
  only.** It was a plain object that kept a `0` entry for every refId ever
  removed — unbounded growth in a long-lived room with churn (heap growth over
  a churn run: 2 175 → 213 KB). Read it with `refCount.get(refId)`; a removed
  instance reads `undefined`, not `0`. Re-adding a removed instance still
  re-emits it (the signal moved to the tree's `needsRestage` flag).
  `MapSchema.keyByIndex` is a `RefTable` too (decoding a 10 000-entry map
  −18…−20 %).
- **`KeyedRecorder` (Map / Set / Stream change recorder) no longer keeps its
  pending ops in a `Map`.** That Map was cleared every tick, and a cleared Map
  drops its table and re-grows it with rehashing — `ops.set` was 23 % of a
  REPLACE-heavy tick. Pending ops are now an insertion-order list plus one
  byte per wire index in lazily allocated 4 KB pages (same wire order, same
  bytes): `MapSchema.set` on existing keys −31 % (string keys) / −45 % (number
  keys), `encoder/map-replace` −23…−38 % with GC time → ~0. `recorder.ops` is
  gone: use `opAt(index)`, `forEach`, `indexes()`, `order` / `count`.
- **`$values` is created at its exact size** (`numFields + 1`, a clone of a
  packed per-class template) instead of `[]`, which V8 grows to a 17-slot
  backing store on the first write: retained memory per entity −10 %,
  `encoder/construct` −26 % (GC time ÷3), a 10 000-entity full-state decode
  −22 %, and field reads in tight loops −10…−20 % (`ArraySchema` `forEach` /
  `for…of` / `map` / `filter`, reads of a decoded array). `$values.length` is
  the class's field count from construction, not the highest field written.
- `ArraySchema` trees live in a private slot on the raw array (not on the
  Proxy): array construction −60 %, entity construction −9 %, decoder bootstrap
  −10 %. `arraySchema[$changes]` keeps working through the accessor.
- `ChangeTree.parentTree` replaces the `parentRef` slot (`parentRef` is now a
  getter over it), and `setParent` / `addParent` take the parent's tree as an
  optional last argument: attaching −6…−9 %, nested area-of-interest rooms
  −7 %, no memory cost.
- **`ArraySchema` `for…of` / `values()` reuse one iterator result object**,
  updated in place, instead of allocating a `{ value, done }` per element:
  −27 % on a decoded array, −20 % on the encoder side, no GC. `for…of`, spread,
  destructuring, `Array.from` and `yield*` are unaffected; code that keeps a
  result across `next()` calls (`const a = it.next(); const b = it.next();`)
  sees `a.value` change. `keys()` / `entries()` still return fresh results.
- **Decoder-only bundles leave out `Encoder` / `Root` / `EncodeOperation`**
  (`npm run size`): `Reflection.encode` goes through the encoder instance
  instead of a module-level reference, so a client that imports the decoder
  side (the SDK's names) and tree-shakes with rollup / Vite ships 31.5 KB gzip
  instead of 41.2 KB (5.0: 28.8 KB). esbuild / bun keep every class with a
  static field, so they drop little.

### Added

- `ArrayLog` / `KeyedRecorder`: one change recorder per collection, owned by
  the collection (`ChangeTree.rec`). Custom primitive types registered after
  import now work as collection children.

## [5.0.24]

### Fixed

- Rename Symbol and Go to Definition work on `schema()` fields in VS Code,
  including on a `toJSON()` result. Both reported "You cannot rename this
  element" / "No definition found" while autocomplete kept working. Thanks
  @ColaFanta ([#958](https://github.com/colyseus/colyseus/issues/958)).


## [5.0.23]

### Added

- `schema-codegen --swift` generates typed Swift classes for the Colyseus Swift
  SDK. `--bundle` and `--namespace` work the same as on the other targets.

## [5.0.22]

### Added

- `t.array<Mark>("uint8")` refines the element type — the collection mirror of
  `t.uint8<Mark>()`, and the same for `t.map` / `t.set` / `t.collection`. An
  enum or literal-union element was rejected outright, leaving a `number`
  element type as the only option. Thanks @jeffreyhugh
  ([Discord](https://discord.com/channels/525739117951320081/1542326053018800178)).

### Fixed

- `bigint64` / `biguint64` collections infer `bigint` elements. `t.array("bigint64")`
  and `@type(["bigint64"])` typed them as the literal string `"bigint64"`.

## [5.0.21]

### Fixed

- A `schema()` class created with `.extend()` and no `initialize()` of its own
  now runs the parent's; its init props were accepted and silently dropped.
- `.extend()` throws on a field that redeclares one from the parent instead of
  registering it twice and corrupting decoding.
- `class X extends MySchema {}` on a `schema()` result no longer fails with
  `TS2417`.

## [5.0.20]

### Fixed

- TypeScript 7: schema definitions no longer fail with `TS2589: Type
  instantiation is excessively deep`. Thanks @LarryLing
  ([Discord](https://discord.com/channels/525739117951320081/1542028538901823508)).
- `SchemaType<>` and `this` inside `schema()` methods include the members of
  a custom base class.
- A generic `Schema` subclass with a field typed by its own type parameter
  satisfies `extends` constraints.
- `restore()` accepts a plain object literal of the fields under `strict`.
- Decoder callbacks (`onAdd` / `onRemove` / `onChange`, `$()`) accept fields
  declared as plain arrays (`@type([Item]) items: Item[]`) again.

## [5.0.19]

### Added

- **`schema-codegen` now resolves TypeScript path aliases.** An import written
  as `@schemas/Player` — mapped through `compilerOptions.paths` or `baseUrl` —
  was skipped, so the schemas behind it were silently missing from the generated
  client code. Barrel files (`export * from "./Player"`) are followed too, an
  alias that resolves to nothing now warns instead of failing quietly, and
  `--tsconfig` picks the config to read the aliases from when the sources live
  outside that project.

  Thanks to [@essaenko](https://github.com/essaenko) for the report
  ([#186](https://github.com/colyseus/schema/issues/186)).

## [5.0.18]

### Fixed

- **A `@view` tag no longer filters that Schema class everywhere else it is
  used.** Tagging a single field — `@view() @type(Inventory) inventory` on a
  player — also hid the contents of every other `Inventory` in the state,
  including ones on a fully public path such as a building's chest: clients
  received the empty container and none of its children, with no error to
  point at it. Self-referencing types (a `Node` holding a map of `Node`) were
  worst hit — one tagged branch blanked the children of all of them.

  Thanks to [@AndadH](https://github.com/AndadH) for the report and the
  narrowed-down schema ([#204](https://github.com/colyseus/schema/issues/204)).

## [5.0.16]

### Fixed

- **`StateView` operations no longer go stale when the array reindexes later
  in the same tick.** `view.add(item)` followed by an `unshift()`, `reverse()`
  or `move()` on the same `@view` array — within one patch — addressed the
  item's old slot: the added item never reached the client (`"refId" not
  found` on the console), and `view.remove()` in the same position silently
  left the removed item visible. Sibling of the cross-tick case fixed in
  5.0.13.

- **`move()` / `shuffle()` on a `@view`-filtered array no longer corrupt the
  patch for viewing clients.** Reorder operations emitted a refId where
  decoders read an array index. Filtered clients hold per-view subsets, so
  element order is not synchronized for them — reorders now ship as
  identity-based operations existing decoders already understand (no SDK
  update needed).

## [5.0.15]

### Fixed

- **`ArraySchema.reverse()` no longer desyncs clients when it follows another
  change in the same patch.** A `push()`, `pop()`, `shift()`, `unshift()`,
  `splice()` or index write earlier in the tick made the reversal ship wrong
  elements — clients ended up with duplicated or stale entries and never
  recovered. `reverse()` in a tick of its own was already fine. When other
  changes are pending, the reversal now goes out as a full re-state of the
  array (existing wire operations — no SDK update needed), so `onAdd`/`onRemove`
  fire for the re-stated items in that case.

## [5.0.14]

### Fixed

- `SchemaType<>` and `toJSON()` no longer mark every field optional in projects
  compiled with `strictNullChecks: false` (the tsconfig `create-colyseus-app`
  generates) — a Schema instance now satisfies a plain interface like
  `{ x: number }`.

## [5.0.13]

### Fixed

- **`StateView` now addresses the right element after an `ArraySchema` is
  reindexed.** Following a `shift()`, `splice()`, `unshift()`, `reverse()` or
  `sort()`, `view.add(item)` could emit a reference the client was never
  introduced to — `"refId" not found`, the item missing for good, and no
  recovery short of a rejoin — while `view.remove(item)` failed silently,
  leaving an item visible to a client that was meant to stop seeing it.
  Collections that reindex every tick, such as a capped chat or event feed,
  were the most exposed.

  Thanks to [@serjek](https://github.com/serjek) for the detailed report and
  reproduction ([#231](https://github.com/colyseus/schema/issues/231)).

## [5.0.12]

### Added

- **`@fullStateOnly` decorator** — decorator-style equivalent of the
  `.fullStateOnly()` builder chainable, completing delivery-modifier parity
  (`@unreliable` and `@patchOnly` already existed). Combining it with
  `@patchOnly` throws at decoration time, in either decorator order —
  matching the builder's guard.

### Fixed

- `@unreliable` fields now ship their FIRST value on the reliable channel, with
  the owning instance's ADD; only later mutations go out unreliably. Previously
  every value went unreliable, so an instance created after a client connected
  had its `@unreliable` fields written against a refId that client had not been
  told about yet — the decoder dropped those writes, and the value was missing
  until the field changed again (permanently, for a field only written at
  spawn). It bit hardest with the unreliable channel running faster than the
  reliable one, which is the case the split exists for. `encodeAll` already
  seeded these fields for late joiners; a mid-session ADD now matches.

- **A Schema now holds at most 63 fields, down from 64.** The 64th slot could
  encode an operation as byte 255 — the same byte decoders read as
  `SWITCH_TO_STRUCTURE` — which desynchronized every client from that point on,
  with `"refId" not found` in the console. Any nullable field could trigger it,
  not just child `Schema`s and collections, so the slot is withdrawn rather
  than special-cased. A schema with exactly 64 fields now throws where it is
  defined; split it or nest a child Schema. **No SDK decoder change is
  required** — the byte is simply never emitted.

- Defining one field too many now throws, as the error message always claimed.
  The guard was off by one, so the extra field was accepted and then encoded as
  an operation on field 0, corrupting both fields.

- On a Schema with more than 32 fields, an `@view`-tagged field at index 32 or
  above no longer silently hides an untagged field 32 slots below it. That
  field stopped being broadcast — it was routed to the per-view channel
  instead, so clients without a `StateView` never received it, in patches or in
  the initial state. Tagged data was never exposed to the wrong client.

## [5.0.11]

Major release. The encoder internals were rewritten and a new authoring API was
introduced. **Decorators keep working and produce byte-identical output** —
there is no forced migration.

~2.4× faster than 4.0.27 across 51 benchmarked workloads (geometric mean, 50 of
51 at p<0.001), with retained heap roughly halved. Method and full results in
`bench/results/BLOG_v4_vs_v5.md`.

### Added

- **`schema()` + the `t.*` field builders** — decorator-free definitions that
  run in plain JavaScript, with no compiler configuration:

  ```ts
  export const Player = schema({
      name: t.string(),
      hp: t.uint8().default(100),
  }, "Player");
  export type Player = SchemaType<typeof Player>;
  ```

  Returns a real class: `initialize(props)` acts as the constructor body,
  function-valued properties become methods, and `.extend()` builds a real
  prototype chain.
- **Field modifiers** — `.default(value | factory)`, `.optional()`,
  `.deprecated()`, `.view(tag?)`, plus:
  - `.noSync()` — local-only: typed and initialized, never synchronized.
  - `.unreliable()` — patches carry the field on the unreliable channel.
    Primitive fields only.
  - `.patchOnly()` — tick patches only; never in a full state sync, so a late
    joiner never sees it.
  - `.fullStateOnly()` — full state sync only; never in a tick patch. For
    room-wide data set during `onCreate()`.

  Those are the only two delivery channels, so marking a field both throws.
- **`t.stream(Entity)` / `StreamSchema`** — priority-batched collection for
  ECS-style workloads. Additions drain at most `maxPerTick` per client per
  encode pass, ordered by `.priority((view, element) => number)`. `.stream()`
  opts a Map/Set/Collection into the same batching; not supported on
  `ArraySchema`. **Experimental — the API may change.**
- **`view.subscribe(collection)`** — standing per-view subscription to a
  collection's future contents.
- **`t.quantized()` / `t.angle()`** — a bounded float carried as an 8/16/32-bit
  unsigned integer, `"clamp"` or `"wrap"`. Lossy, but identically so on both
  peers, so client prediction and server simulation read the same value.
- **`@colyseus/schema/input`** — `InputEncoder` / `InputDecoder` for the client
  input path, always delta-encoding.
- **`Decoder.decodeResync(bytes)`** — reconcile a full state sync over live
  state on the reconnect path: entries the payload omits are pruned through the
  regular DELETE path, survivors keep instance identity and callbacks.
- **`createPool(ctor)` / `Schema.reset()`** — server-side instance pooling for
  spawn/despawn-heavy rooms. Pooled instances encode byte-identically to fresh
  ones. Does not clear primitive values — re-assign every field after
  `acquire()`.
- **Change-tracking control** — `pauseTracking()`, `resumeTracking()`,
  `untracked(fn)`, `markDirty(index)`.
- **Type helpers** — `Data<T>` (the plain data shape of an instance type),
  `BuilderInitProps<T>`, generic narrowing on primitives
  (`t.int8<-1 | 0 | 1>()`), and `Reflection.makeEncodable(ctor)`.

### Changed

- **Raw string field types are rejected by `schema()`** — write `t.string()`.
  They remain valid as collection child types (`t.array("string")`), and the
  `@type("string")` decorator form is unaffected.
- **`Reflection.encode()` takes an `Encoder`**, not a state instance, and
  **`Reflection.decode()` returns a `Decoder`** — read `decoder.state`.
- `defineTypes()` is **soft-deprecated**: works as in 4.x, warns once.
- Default `Encoder.BUFFER_SIZE` raised 8 KB → 16 KB, so typical full-room syncs
  no longer trigger auto-grow plus a one-time `buffer overflow` warning.
- RefIds are allocated monotonically and never recycled — a refId is a stable
  identity for the lifetime of the room.
- Internal `"~prefix"` string keys are real symbols, created via `Symbol.for()`
  so duplicate copies of the library in one realm interoperate.

### Fixed

- `ArraySchema`: consecutive and multi-item `unshift()`, and `unshift()` mixed
  with other same-tick operations (#193). Unshifting Schema instances no longer
  crashes the decoder.
- `ArraySchema`: deletes of Schema children are idempotent, so a client that
  received a full state sync mid-tick no longer corrupts on the next patch.
- `ArraySchema`: interleaving index writes with `shift()` / `splice()` in one
  tick no longer desyncs clients.
- `StateView`: `view.add(obj)` with the default tag no longer leaks
  non-matching `@view(tag)` fields to that client.
- `StateView`: per-tree visibility bits are cleared on dispose, closing an
  ID-reuse leak between views.
- `StateView`: re-adding an already-visible instance to an iterable view no
  longer duplicates it in `view.items`.

### Wire format

Byte-identical to 4.x except for these three, which **every SDK decoder must
implement** for the 0.18 line:

- **`ADD` at an occupied array index means insert**, shifting items up
  (previously only `index === 0` was special-cased). During `decodeResync()`,
  snapshot ADDs remain positional overwrites.
- **`ArraySchema` deletes of Schema children are always `DELETE_BY_REFID`.**
  Decoders must skip operations for unknown refIds entirely — no
  delete-at-`-1`, no spurious `onRemove` — while preserving the ref-count
  decrement.
- **The reflection payload retired its colon grammar.**
  `"quantized:min,max,bits,wrap"` and `"array:string"` are gone: quantized
  descriptors ride as a schema-typed `QuantizedDescriptor` ref, and a primitive
  collection child rides `ReflectionField.childPrimitive`.

`CollectionSchema` / `SetSchema` decoding now preserves the wire index.
Fixture generators live in `test-external/`.

## 4.0.31

### `StateView` operations after an `ArraySchema` is reindexed

`view.add(item)` and `view.remove(item)` now address the right element after a
`shift()`, `splice()`, `unshift()`, `reverse()` or `sort()`. The reindex used to
leave the view aiming at whichever element had inherited the slot: `view.add()`
emitted a reference the client was never introduced to — `"refId" not found`,
the item missing for good, and no recovery short of a rejoin — while
`view.remove()` failed silently, leaving an item visible to a client that was
meant to stop seeing it. Collections that reindex every tick, such as a capped
chat or event feed, were the most exposed.

Thanks to [@serjek](https://github.com/serjek) for the detailed report and
reproduction ([#231](https://github.com/colyseus/schema/issues/231)).

## 4.0.30

### `MapSchema.getOrInsert()` and `getOrInsertComputed()`

`MapSchema` now implements `getOrInsert(key, defaultValue)` and
`getOrInsertComputed(key, callbackfn)` — the `Map.prototype` "upsert" methods
from the TC39 proposal, typed in TypeScript 6's standard library:

```typescript
// returns existing value, or inserts (and returns) the default
const player = state.players.getOrInsert(sessionId, new Player());

// same, but the value is only constructed when the key is missing
const player = state.players.getOrInsertComputed(sessionId, () => new Player());
```

Insertions go through the regular `set()` path, so they are tracked and
synchronized like any other change; when the key already exists, the existing
value is returned and nothing is enqueued for encoding.

This also completes the native `Map` contract on TypeScript 6 and 7: with
`lib: ESNext` (where `Map` declares these methods), assigning a `MapSchema`
where a `Map<K, V>` is expected no longer fails — complementing the iterator
fix from 4.0.29. On the runtime side these methods are always available,
regardless of engine support for the proposal.

## 4.0.29

### `MapSchema` iterator type now follows the native `Map` contract

TypeScript 5.6 changed the standard library so `Map[Symbol.iterator]()` returns
`MapIterator` (which includes the iterator-helper methods) instead of
`IterableIterator`. `MapSchema`'s explicit `IterableIterator<[K, V]>` annotation
was narrower, so on TS 5.6+ with `lib: ESNext`:

- assigning a `MapSchema` where a `Map<K, V>` is expected failed with TS2322 —
  even under the recommended `skipLibCheck: true`;
- projects with `skipLibCheck: false` also got TS2416 from the shipped
  declarations (`'[Symbol.iterator]' … is not assignable to the same property
  in base type 'Map<K, V>'`).

`[Symbol.iterator]()` is now typed as `ReturnType<Map<K, V>[typeof
Symbol.iterator]>`, deriving the iterator type from the consumer compiler's own
standard library — `IterableIterator` on TS ≤ 5.5, `MapIterator` on 5.6+. This
is a declaration-only fix; runtime behavior is unchanged.

A new `test:types` check now compiles the generated declarations under strict
`NodeNext` with `skipLibCheck: false` to catch regressions of this kind.

Thanks to [@Hoodgail](https://github.com/Hoodgail) for the contribution (#227).

## 4.0.28

### TypeScript 5 / 6 / 7 compatibility

`@colyseus/schema` now works with any TypeScript major from 5 onwards
(TypeScript 7 is the new Go-based native compiler):

- The `typescript` peer dependency range is now `>=5.0.0` and marked optional —
  installing alongside `typescript@7` no longer fails with `ERESOLVE`, and
  plain-JavaScript projects no longer get a peer warning.
- Internal tsconfigs now pin options whose defaults changed in TypeScript 6
  (`strict`, automatic `@types/*` inclusion), so the package typechecks and
  builds cleanly with 5.x, 6.x and 7.x.
- `schema-codegen` still requires TypeScript 5.x or 6.x installed: TypeScript
  7's native compiler no longer ships the JS compiler API used to parse schema
  files. With `typescript@7` installed it previously exited successfully while
  generating no files — it now fails fast with a clear error message, and the
  CLI exits with a non-zero code on all errors.

The `@type()` decorator (`experimentalDecorators` + `useDefineForClassFields:
false`) remains fully supported by TypeScript 6 and 7.

## 4.0.27

### Encoder: fix `@view` corruption when a filtered patch grows the buffer

With many filtered changes for a client, a single `Encoder` flush could exceed
the default 8 KB `BUFFER_SIZE` and reallocate the shared buffer mid-flush. When
that happened, `encodeView()` / `encodeAllView()` kept slicing from the old (now
discarded) buffer and left the shared iterator's `offset` stuck at the
pre-resize overflow value — so every *subsequent* client in the same flush got a
corrupted patch. The `view.changes` write loop also had no overflow guard, and
its operations are cleared immediately after, so a dropped write couldn't be
recovered by re-encoding. On the decoder this surfaced as misaligned values
(e.g. positions decoding as huge floats), `"refId" not found`, and
`previousValue.entries is not a function`.

It mostly affected rooms with `@view()`-filtered collections holding many
visible children (lots of nearby players/NPCs). Adding fields to those schemas
made it more frequent by enlarging each patch.

Buffer growth is now a single `ensureCapacity()` helper used by both the
`encode()` resize path and the `view.changes` loop; the resize re-encode reuses
the same iterator so `offset` stays accurate; and the per-view methods slice
from the buffer that `encode()` returns. Large filtered patches are also
~15–20% faster, since growth is incremental instead of re-encoding the whole
changeset on every overflow.

Thanks to [@TJEvans](https://github.com/TJEvans) and
[@XT60](https://github.com/XT60) for the report.

## 4.0.26

### Decoder: fix "refId not found" when replacing a collection that holds a shared child

A `Schema` instance shared between a collection and another holder (e.g. an
array element also assigned to a sibling field) could be dropped on the client
when that collection was replaced in the same patch, surfacing as
`"refId" not found` / `trying to remove refId that doesn't exist` decode errors.

The collection-replace path in `decodeValue` was decrementing each previous
child's refId, then `garbageCollectDeletedRefs()` decremented them again — a
*shared* child got double-counted and dropped while still referenced. Child
reference-counting is now left to GC. A guard also releases the previous
collection's own refId when the replacement op isn't tagged `DELETE` (e.g. an
`encodeAll()` not followed by `discardChanges()`), preventing a leak.

Thanks to [@beemdvp](https://github.com/beemdvp) for the report.

### `@view()` now accepts bitwise tags

The `@view()` decorator can now be given a bitmask of tags
(`@view(Tag.A | Tag.B)`). A field becomes visible to any client whose
`view.add(obj, tag)` call shares at least one bit with the field's mask, so a
single field can be exposed to multiple tag audiences at once.

Internally, per-`ChangeTree` tag storage moved from `WeakMap<ChangeTree,
Set<number>>` to a single integer bitmask, with membership resolved via bitwise
`&` instead of `Set` lookups. Custom tags must therefore be powers of two
(`1 << 0`, `1 << 1`, ...). The default `@view()` tag is unaffected.

Thanks to [@FTWinston](https://github.com/FTWinston) for the contribution.

## 4.0.25

### `@view(N)` collections: items pushed after `view.add` are now visible

Items added to a non-default-tag collection (e.g.
`@view(1) @type([Item]) items`) *after* the client called
`view.add(state, 1)` were silently invisible — the array's `ADD` op
was emitted but the new item's fields didn't share visibility with the
parent.

Children of `@view(N)` collections now inherit parent visibility.
Default-tag `@view()` collections keep per-item gating unchanged —
`view.add(item)` is still required to opt each one in.

Thanks to [@FTWinston](https://github.com/FTWinston) for the report
and fix (#226).

## 4.0.24

### `ChangeTree.delete`: fix `encodeAll` dropping sibling fields after `undefined` assignment to a `@view()` field

Thanks to [@Gabixel](https://github.com/Gabixel) for the follow-up
report after 4.0.22.

On a Schema with both `@view()` and non-`@view()` fields, assigning
`undefined` to the `@view()` field evicted an unrelated sibling from
`allChanges`. Incremental clients were fine; a fresh client joining via
`encodeAll()` saw the sibling field silently missing.

`delete()` was picking its target changeset by `filteredChanges !== undefined`
instead of mirroring `change()`'s per-field `isFiltered` test, so the
matching `deleteOperationAtIndex` ran on the wrong side and its
"find last operation" fallback removed a neighbor. Now symmetric with
`change()` across both the `*Changes` and `*allChanges` pairs.

## 4.0.23

### `Callbacks`: accept Schema instances across multiple `@colyseus/schema` copies

The nested-instance overloads of `onAdd`, `onChange`, `onRemove`, and `bindTo`
previously declared `<TInstance extends Schema, ...>`. When two copies of
`@colyseus/schema` end up in `node_modules` (e.g. one in the consuming app and
one transitively pulled in by an SDK), TypeScript infers `data` parameters
with a structural shape that doesn't extend the *local* `Schema` class, and
`TInstance` collapses to the base `Schema`. That made
`CollectionPropNames<TInstance>` evaluate to `never`, surfacing as the
infamous *"Argument of type '"playingUsers"' is not assignable to parameter
of type 'never'"* on otherwise-correct code like:

```ts
callbacks.listen("gameData", (data) => {
    callbacks.onAdd(data, "playingUsers", (user) => { /* ... */ });
});
```

The constraint is now relaxed to match the same pattern already in `listen`:

- `onAdd`, `onRemove`, `bindTo`: `<TInstance, ...>` (no constraint)
- `onChange`: `<TInstance extends object, ...>` — `extends object` is kept
  here only to disambiguate the 2-arg `onChange(instance, handler)` overload
  from the 2-arg `onChange(property, handler)` overload, so a string property
  name still routes to the root-collection form.

Misspelled property names and non-collection properties continue to be
rejected, since `K extends CollectionPropNames<TInstance>` /
`K extends PublicPropNames<TInstance>` still gates them.

Also fixed: `Callbacks.getLegacy()` previously fell through to `undefined`
when the input matched neither `Decoder` nor `{ serializer: { decoder } }`;
it now throws `Invalid room or decoder` to match `Callbacks.get()`.

## 4.0.22

### `StateView`: fix `"refId" not found` from out-of-order `view.changes`

`Encoder.encodeView` iterated `view.changes` in Map insertion order, which
isn't always topological. Sequences that mixed `view.remove` with a later
`view.add` — including `view.add` after re-parenting an instance via a
collection push — could leave a child's entry in the Map ahead of an
ancestor that hadn't been touched yet. The wire stream then emitted
`SWITCH_TO_STRUCTURE` for the child before any earlier op had registered
its refId on the decoder, surfacing as `"refId" not found` (and the
remainder of that patch silently skipped).

`Encoder.encodeView` now iterates in topological order via a DFS
post-order over the parent chain. The pass is gated on a
`StateView.changesOutOfOrder` flag set inside `StateView.remove` (the
only operation that bypasses `addParentOf`'s deepest-ancestor-first
ordering) and reset when `view.changes` is cleared, so the hot path
stays at plain Map iteration when no `remove` happened in the tick.

Same wire-order class as colyseus/colyseus#936; the fix here closes it
at the schema layer so any consumer of `Encoder.encodeView` gets a
topologically ordered stream by construction.

Thanks to @anaibol for the test cases ported from colyseus/colyseus#936
and to @Gabixel for the standalone reproducer at
[Gabixel/colyseus-test-stateview-repo](https://github.com/Gabixel/colyseus-test-stateview-repo).

## 4.0.21

### `@view`: nested Schema fields inherit parent visibility

Previously, when a `@view`-gated field held a nested `Schema`, the nested
instance was encoded but its fields were not — clients would see the reference
but every property came through as `undefined`. The only workaround was to wrap
the nested instance in an `ArraySchema`, which propagated visibility from the
parent.

Nested `Schema` fields now inherit visibility from a `@view`-gated parent
regardless of whether the parent is a collection. Nested fields decorated with
their own `@view` continue to opt out, so explicit per-field gating is
preserved.

Thanks to @FTWinston for the contribution (#218).

## 4.0.20

### C# codegen: emit native `enum` for positive-int enums

The Unity/C# code generator now emits a native `public enum Name : int { ... }`
when every member of a TypeScript enum resolves to a non-negative integer
(implicit index-based or explicit positive int values). String and float enums
continue to emit `public struct` with `public const` fields, since C# native
enums only support integral underlying types.

Benefits: improved type-safety and proper dropdown display for serialized
enum fields in the Unity Inspector.

**Potential source-level break:** native C# enum values are strongly typed,
so comparisons against raw ints now require a cast — e.g.
`if ((int)myEnum == 0)` or, preferably, `if (myEnum == MyEnum.Foo)`.
Wire format is unchanged.
