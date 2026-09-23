# L07 — leads 07 + 08 (correctness) — results, v3 (after two review rounds)

Worktree `schema-L07` @ 16ff6be, uncommitted. Hand-back: `schema-L07-src.patch` (src + tests),
`schema-L07-docs.patch` (LEADS 07 + 08 closed, README rows).

## Design chosen

**08 — separate id spaces.** Evaluated first, as asked: nothing on the encoder or on a relay's downstream wire needs
identity with upstream ids (downstream clients only ever see the relay's ids), and the decoder reads an instance's id only
through its own accessors (`decodedRefIdOf`, `addRef`, `decodeBody`, callbacks, GC, resync). So:

- The decoder's id moves to its own slot, `decodedRefId` on `UntrackedChangeTree` (which also remembers its `tracker`). The
  rare TRACKED tree a decoder addresses (the root of `new Decoder(state)`, an instance an encoder took over) keeps its
  decoder bookkeeping (id + `decodeInfo`) in that decoder's `ReferenceTracker.trackedRecords` (strong per-decoder `Map`,
  `recordOf`) — no `ChangeTree` slot, no lazily added property, no process-wide `WeakMap` (round-3 finding 6). `ChangeTree.refId` is the encoder's id only.
- `ensureTracked` (moved to `ChangeTree.ts`, exported) no longer copies the decoder id; `Root.add` allocates. The stub
  object becomes the tree's decoder record so the decoder keeps addressing the instance. Stub detection is positive
  (`isTracked === false`, prototype getter on `UntrackedChangeTree`); anything else — including a tracked tree from
  another library copy — is treated as tracked (the mechanism docs/perf/leads/09 planned, cross-copy safe).
- `UntrackedChangeTree.setParent` / `setRoot` upgrade the stub and attach the real tree — but ONLY when the adopting
  parent is attached to a Root (`setParent(parent, root)` with a root, or `setRoot`). A parent without a Root leaves the
  stub alone: that is the normally-constructed root of `new Decoder(state)`, whose fields the decoder itself assigns
  (`ref[name] = value` runs the tracked setter) — upgrading there turned every decoded root-level collection into a full
  ChangeTree and cost `decoder/bootstrap` +12 %, `decoder/map-bootstrap` +14…20 % in the first v3 build. With the guard,
  the decoder path is HEAD behaviour; a stub under a detached parent is upgraded by the ROOT ATTACH WALK when that parent
  enters an encoder — and the walk attaches it through `setParent(parent, root, index, parentTree)` (round-3 findings
  1–2), so the edge and the inherited flags are exactly those of a normally assigned instance. The walk's per-child
  `ensureTracked` (`instanceof`) call is gone; `Encoder.setState` just calls `setRoot` (finding 7).
- An upgraded tree enters with `IS_NEW | NEEDS_RESTAGE`: its contents were never recorded, so `Root.add` re-stages them
  for the incremental patch (same flag a pooled instance re-enters with).
- `ref[$refId]` = `refId ?? decodedRefId` (decoded instances and a decoder root read as before; a relay instance reports
  the relay's id). `Callbacks` / `getDecoderStateCallbacks` / `ArraySchema.$resyncPrune` / `Schema.debugRefIds(…, decoder)`
  use `decodedRefIdOf`. `Root.reserveRefIds` and the `setState` seed step are gone.

**07 — contracts instead of heuristics.**

- `Schema.initialize` is idempotent: an instance that already owns a tracked tree (`tree.ref === instance &&
  tree.isTracked`) keeps it. The first call already builds the tree for the final class (`instance.constructor`), so
  later per-inheritance-level calls are no-ops; fields assigned in between stay on that tree. No refId/root heuristics.
- `[$changes]` setter installs the tree as-is; contract documented on the accessor (a tree belongs to the instance it
  was built for; installing another instance's tree is unsupported). For an own Schema-kind tree it re-reads
  `tree.values = this[$values]`. Nothing is half-moved.
- `ChangeTree.values` contract documented on the field; the `values !== undefined` guard in `forEachChildWithCtx` stays.

## The 9 review findings

| # | finding | how it is handled |
| --- | --- | --- |
| R1-a | per-tree bump in `Root.add` (walk-order dependent, hot path) | gone; `Root.add` unchanged from HEAD |
| R1-b | `instanceof ChangeTree` breaks cross-copy | the only `instanceof ChangeTree` (attach walk) is REMOVED; `isTracked` prototype getter instead |
| R1-c | dropped `values !== undefined` guard | kept (HEAD version untouched) |
| 1 | reserve step only when root has a refId (fresh root / graft) | no reserve step: the encoder never inherits decoder ids. Tests: "decoded subtree placed under a fresh root", "decoded instance grafted into a running Encoder" |
| 2 | relay keeps decoding: shared `tree.refId` slot | separate slots. Test (un-skipped, rewritten): primitive + replaced child from upstream after the takeover, decoder releases the replaced child by ITS id, relay ids unique + registered, `encodeAll` and incremental `encode` downstream. Collection ENTRIES the upstream adds after the takeover remain unsupported → `it.skip` with the reason (owner decision below) |
| 3 | decoder-built root crashes `setRoot is not a function` | `Encoder.setState` → `ensureTracked(...)`; stubs also implement `setRoot`. Test: "root built by the decoder (Reflection)" |
| 4 | `[$changes]` setter half-moves a tree | reverted to install-as-is + documented contract; own-tree `values` re-read only. Tests: own tree via the setter; `it.skip` for a foreign tree (unsupported) |
| 5 | `initialize` early-return heuristic changes public behaviour | replaced by idempotence on own tracked tree; "explicit re-initialize rebuilds" dropped deliberately (owner decision below). Tests: per-level keeps children; second call is a no-op on a Schema subclass and on an external class |
| 6 | `reserveRefIds` second walk + Set + closure | removed |

## Round-3 review findings

| # | finding | how it is handled |
| --- | --- | --- |
| 1 | root walk upgraded children via `setRoot` → no parent edge, no inherited flags | `setRoot`'s child walk carries `{parentRef, parentTree, root}` (ctx pool like `setParent`); a stub child (`isTracked === false`) is attached through `child.setParent(parent, root, index, parentTree)` → edge recorded, `checkIsFiltered` inheritance, view/stream/patchOnly flags as for any assigned instance. Test: "…parent edge and inherited @view flags" (parentTree chain, `isFiltered === true` on the `@view` child, `StateView.add` on an upgraded map entry, view / no-view clients round trip) |
| 2 | stub `setParent` without root drops the edge | same mechanism: the edge is recorded when the walk attaches it. "…placed under a fresh root" now asserts the `parentTree` chain and `new StateView().add(fresh.player)` |
| 3 | `Schema.initialize` discarded a stub | `ensureTracked(existing)` (in place: values, decoder id, record survive) |
| 4 | `[$refId]` accessor asymmetric | setter writes the side the instance is on: stub → decoder id, tracked → `refId`; getter unchanged |
| 5 | `isTracked` getter misclassifies foreign tracked trees | every check is a POSITIVE stub test (`isTracked === false`): `ensureTracked`, `Schema.initialize`, `_setRootChildCb`, `addRef`, `decodedRefIdOf`, `$refId` accessor. A tree without the getter is treated as tracked (HEAD behaviour: `setRoot` called on it) |
| 6 | lazily added `decodedRefId` / `decodeInfo` on upgraded trees → second hidden class | neither lives on `ChangeTree`: a tracked tree's decoder bookkeeping is an `UntrackedChangeTree` record in ITS decoder's `ReferenceTracker.trackedRecords` (strong per-decoder `Map`); the upgraded stub becomes the record (`stub.tracker`), a `new Decoder(state)` root gets one on demand. Zero cost on every encoder path and zero memory per server tree; a tracked tree a decoder addresses pays one `Map.get` per chunk. A process-wide `WeakMap` was tried first and rejected on numbers (bench section) |
| 7 | two upgrade entry points | `Encoder.setState` → `refTreeOf(state).setRoot(root)`; the stub's own `setRoot` / `setParent` upgrade; `ensureTracked` is the single primitive |
| 8 | dead `tree.values = this[$values]` branch | removed; setter is `TreeStamp.put` + the ownership contract comment |

## Tests

`test/Metadata.test.ts`: per-inheritance-level `initialize` (+ idempotence), `initialize` on a Schema subclass keeps the
constructor's tree, setter keeps `tree.values` on own `$values`, `it.skip` foreign tree.
`test/Schema.test.ts` › "encoder: encodeAll": re-encode with Schema children; children gained BEFORE the Encoder
attaches; relay keeps decoding after re-encoding; `it.skip` upstream collection entries after takeover; decoded subtree
under a fresh root; graft into a running Encoder (incremental); Reflection-built root.

HEAD verification (`src/` stashed, tests kept, `--grep` on the 9 new behaviour tests): **0 passing, 9 failing** on 16ff6be
(per-level initialize: `{ d: { b: 2 } }`; idempotence: tree replaced; the six relay tests: duplicate refIds / `setRoot is not
a function` / "cannot encode … without a refId"). The "setter keeps `tree.values` on own `$values`" test passes on HEAD as
well — it pins the contract, it is not a regression test. Two `it.skip` (foreign tree; upstream collection entries after
the takeover) state the unsupported cases.

Note on finding 3: `Reflection.decode` builds its root with `new rootType()` (tracked), so the crash comes from a
decoder-built root (`X.initializeForDecoder()` handed to `new Decoder`), which is what the test uses. Reflected classes are
decode-only until `Reflection.makeEncodable` — unrelated to this lead.

`npm test` (PowerShell, under the lock): **1091 passing, 3 pending** (HEAD baseline 1081 + 10 new; pending = baseline 1 +
the 2 documented `it.skip`). `test:types` clean. Affected files re-run after every round-3 change: 278 passing / 3 pending.

## Bench (round 3: `R8-A` = clean 16ff6be build vs `L07-v3` = final build, `--samples 10`, one filter per run)

| scenario | A med | B med | Δ% | p |
| --- | --- | --- | --- | --- |
| mutations/tree-build/construct | 1.141 ms | 1.144 ms | +0.2 | 0.791 |
| mutations/tree-build/attach-fresh | 2.671 ms | 2.641 ms | −1.1 | 0.104 |
| mutations/tree-build/attach-steady | 2.802 ms | 2.787 ms | −0.5 | 0.521 |
| encoder/heavy-tick/default | 0.5724 ms | 0.5721 ms | −0.1 | 1.000 |
| encoder/construct | harness prints no row for `--filter "encoder/construct*"` in this worktree; `mutations/tree-build/construct` covers construction | | | |
| decoder/bootstrap/default | 1.836 ms | 1.854 ms | +0.9 | 0.162 |
| decoder/bulk-add/turnover | 4.947 ms | 4.941 ms | −0.1 | 0.385 |
| decoder/bulk-add/bootstrap | 23.16 ms | 22.34 ms | −3.5 | 0.017 |
| decoder/churn/default | 21.98 µs | 22.43 µs | +2.0 | 0.089 |
| decoder/deep-nested/default | 5.038 µs | 4.883 µs | −3.1 | 0.005 |
| decoder/map-bootstrap/players-str-1000 | 1.036 ms | 0.931 ms | −10.2 | 0.002 |
| decoder/map-bootstrap/players-num-1000 | 0.914 ms | 0.780 ms | −14.7 | 0.002 |
| decoder/map-bootstrap/scores-{str,num}-10000 | | | −1.9 / −0.9 | 0.031 / 0.121 |
| decoder/map-churn/str, num | | | −10.1 / +1.3 | 0.045 / 0.910 |
| decoder/map-replace/str, num | | | −0.1 / +0.6 | n.s. |
| decoder/resync/full | 1.446 ms | 1.475 ms | +2.0 | 0.003 |
| decoder/resync/churn | 1.562 ms | 1.622 ms | +3.8 | 0.026 |
| decoder/tick/default | 63.5 µs | 62.8 µs | −1.1 | 0.064 |

Encoder rows neutral. Decoder bootstrap rows neutral-to-faster (the map-bootstrap gain: the decoder no longer writes its id
into the tracked root tree per op — gcMs 9.0→5.8). The only flagged rows are the two resync (rejoin) sweeps at +2…4 %: the
sweep now passes the tracker into `decodedRefIdOf` / `$resyncPrune` per element; a cold path (one full-snapshot reconcile
per reconnect).

**Finding 6, measured.** Round-3 build 1 used a process-wide `WeakMap<ChangeTree, record>` for tracked-tree bookkeeping:
`decoder/bootstrap` **+38 %** (gcMs 20→123), `map-bootstrap` +22…33 %, all GC — a fresh ephemeron key per
`new Decoder(state)` (its root tree) makes every scavenge process the ephemeron table; a standalone micro-benchmark
reproduced it (300 ops: gc 6.5 ms → 80 ms with one `WeakMap.set` per op). Hence the per-decoder strong `Map`
(`ReferenceTracker.trackedRecords`, dies with the decoder) with the tracker threaded into the decoder-side readers; the stub
carries a `tracker` back-reference (one slot on decoder-side stubs, none on `ChangeTree`) so `ensureTracked` can hand the
stub to its decoder as the tracked tree's record. A declared `ChangeTree` slot was not measured: it costs +8 B on every
server-side tree by construction (docs/perf/leads/01: +1.1 % memory per slot) for a decoder-only need.

`node bench_encode.js` (final build): **5458157 bytes** (unchanged).

Behaviour note: `state[$refId]` on the normally-constructed root handed to `new Decoder(state)` now reads `undefined`
(HEAD: 0 — the decoder used to write its id into the tracked tree's `refId`); callbacks and debug helpers read the
decoder's records instead. No test depended on it.

## Open owner decisions

1. **Relay steady state for collections.** After `new Encoder(decodedState)`, entries the upstream ADDS to a collection are
   written by the decoder straight into `$items` (no `set()` → never attached to the relay Root), and their upstream wire
   indexes would share the relay collection's own index space; primitives decoded after the takeover reach `encodeAll`
   only. Options: (a) document "takeover is a hand-off; keep decoding only primitives / replaced Schema children" —
   current state, `it.skip` names the case; (b) a decoder "decode into live state" mode that routes writes on TRACKED
   instances through the collection APIs and keeps a decoder-side `keyByIndex` per map (a project of its own, decoder
   hot-path cost to measure). Recommendation: (a) now; open a lead for (b) if a relay product needs it.
2. **`Schema.initialize` semantics.** Now idempotent (documented in code + docs/perf/leads/07). If "re-initialize resets" must stay
   available, add an explicit `Schema.initialize(instance, { reset: true })` rather than inferring it; nothing in the
   repo or tests used the old rebuild.
