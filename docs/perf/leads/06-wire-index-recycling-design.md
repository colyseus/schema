# 06 — Design: recycling MapSchema wire indexes

**Status:** v1 (MapSchema only) landed 2026-09-24 — outcome in `06-wire-index-recycling.md`; design · written read-only at `2ab22f0` · all paths are relative to the repo root.

## 0. Summary and corrections to the lead

- **Recommendation: v1 recycles MapSchema indexes only, and needs no decoder change.** A decoded map is keyed by the string key, so an index reused under a new key never looks occupied on a client, even one that still holds a stale entry.
- **SetSchema, CollectionSchema and StreamSchema are not safe with today's decoder.** When an ADD lands on an index that already holds a value, `storeKeyValue` ignores it (`src/decoder/DecodeOperation.ts:524`, `if (!ref.$items.has(index))`). But the code at `DecodeOperation.ts:491-499` has already released the previous ref, so the client ends up holding a freed ref. The spec says an ADD onto an occupied index is a replacement (`src/encoding/spec.ts:34-36`). Recycling Set or Stream indexes therefore needs a **decoder change** (§4).
- **The lead's claim that `encodeAll` order would change is mostly wrong.** An inline map body is written from `$items` in insertion order (`writeMapBody`, `src/encoder/EncodeOperation.ts:1001-1032`). Index order appears only where `forEachLive` walks a map (`src/encoder/changeTree/liveIteration.ts:61-66`):
  - `encodeAllView` live chunks for filtered maps (`src/encoder/Encoder.ts:837-847` → `fullSyncCb`, `EncodeOperation.ts:654-665`);
  - `restage` (`src/encoder/ChangeTree.ts:860`);
  - bootstrapping a view with `view.add(map)` (`src/encoder/StateView.ts:549-559`).
- **Only MapSchema restarts at 0 on `clear()`** (`src/types/custom/MapSchema.ts:339`). `SetSchema.clear()` keeps `nextIndex` (`src/types/custom/SetSchema.ts:176-191`); only `$reset` rewinds it (`SetSchema.ts:207`). `StreamSchema.clear()` never rewinds `$nextPosition` (`src/types/custom/StreamSchema.ts:191-203`).

## 1. Current index lifecycle

**Allocation**
- `MapSchema.set` with a new key: `index = this.nextIndex++`, then both mappings are stored (`MapSchema.ts:219-223`).
- A key that is still mapped keeps its index and becomes REPLACE or DELETE_AND_ADD, and `rec.forget(index)` drops the snapshot (`MapSchema.ts:199-217`). This covers the same tick, because mappings linger until the end of the tick.
- `SetSchema.$add` uses `nextIndex++` (`SetSchema.ts:107`). `StreamSchema.add` uses `$nextPosition++` (`StreamSchema.ts:146`).

**Recording a DELETE**
- `MapSchema.delete` → `rec.delete(index, prev)` records a DELETE and snapshots the value in `rec.deleted` (`MapSchema.ts:318-320`, `src/encoder/KeyedRecorder.ts:81-92`). `indexByKey` and `keyByIndex` are left alone.
- `SetSchema.$deleteAt` removes `$items[index]` straight away (`SetSchema.ts:171`). The filter resolves the value through `rec.deleted` (`SetSchema.ts:66`).
- Streamed collections never record. They route through `streamRouteRemove`, which puts a DELETE on `view.changes` (`src/encoder/streaming.ts:106-147`). They call `remember` only if the entry was already sent (`MapSchema.ts:314`, `SetSchema.ts:161`). `StreamSchema.remove` does neither (`StreamSchema.ts:168-184`).
- Recorder merge: an ADD over a pending DELETE becomes DELETE_AND_ADD (`KeyedRecorder.ts:73`). On the wire that is an ADD onto an occupied index (`spec.ts:34-36`).

**End of tick**
- `Encoder.discardChanges` → `discardQueue` → `endEncode` → `$onEncodeEnd` runs before the recorder reset (`Encoder.ts:738-742`, `Encoder.ts:45-49`, `ChangeTree.ts:984-989`).
- MapSchema then purges the mappings of indexes in `rec.deleted` whose key is gone (`MapSchema.ts:449-459`).
- `discard()` fires the same hook without anything being encoded (`ChangeTree.ts:997-1001`).
- SetSchema and StreamSchema have no `$onEncodeEnd`.
- The mappings linger until the end of the tick for two reasons: a same-tick re-set must find the old index (`MapSchema.ts:196`), and the filter and the view drain resolve removed values through `rec.deleted` (`MapSchema.ts:88-92`).

**Per-view `changes`**
- Type: `Map<refId, Map<index|ChangeTree, op>>` (`StateView.ts:128`).
- Entries keyed by a map index are written by:
  - `addParentOf` (`StateView.ts:654-657`);
  - `remove` (`StateView.ts:796-815`);
  - the `_add` live walk (`StateView.ts:549-556`);
  - `unsubscribe` (`StateView.ts:1023-1028`);
  - the stream paths (`streaming.ts:142`, `streaming.ts:225`; `StateView.ts:756`, `StateView.ts:1012`).
- They are drained and then cleared only by `encodeView` (`Encoder.ts:268-280`, `Encoder.ts:295`). `encodeAllView` does not clear them (`Encoder.ts:200-212`).
- The drain resolves each index at drain time: `value = refTarget[$getByIndex](key)`, and an index with no value becomes a DELETE (`EncodeOperation.ts:1147-1154`).
- **Entries survive across ticks for any view that was not `encodeView`ed** before `discardChanges`.

**Stream bookkeeping keyed by position** also persists across ticks: `pendingByView`, `sentByView`, `broadcastPending`, `sentBroadcast` and `broadcastDeletes` (`streaming.ts:36-47`). The priority pass looks positions up with `$getByIndex` (`Encoder.ts:653-657`, `Encoder.ts:705`, `Encoder.ts:584`).

**Decoder**
- On ADD, the map stores both mappings (`DecodeOperation.ts:470-473`); a body does the same (`DecodeOperation.ts:544-547`).
- Other ops resolve the key through `keyByIndex` (`DecodeOperation.ts:478`).
- Replacement is detected as `previousValue !== value` (`DecodeOperation.ts:491`). For maps, `previousValue` is `$items.get(key)`; for Set and Stream it is `$items.get(index)` (`DecodeOperation.ts:481`).
- DELETE → `$deleteByIndex` (`MapSchema.ts:404-411`).
- Resync prunes maps by key and scrubs stale `keyByIndex` entries (`MapSchema.ts:413-441`). Sets prune by index (`SetSchema.ts:248-262`). Streams never prune (`StreamSchema.ts:247-251`). An occupied slot is released in `resyncTouchEntry` (`src/decoder/Resync.ts:61-73`).

**`clear()`:** MapSchema resets both tables and sets `nextIndex` back to 0, and the recorder switches to an absorbing CLEAR (`MapSchema.ts:337-345`, `KeyedRecorder.ts:99-103`).

## 2. Hazards

- **H1: a stale per-view entry.** View V is skipped in tick T while holding `{5: DELETE}`, or an ADD from `addParentOf`. Index 5 is freed and reused in T+1. V's drain then either ships the new occupant as an ADD (a privacy leak, and its visibility bit is never set) or deletes it on V (`EncodeOperation.ts:1149-1150`).
- **H2: a removed child's parent link stays stale.** `root.remove(previousTree)` releases the child's own children but not its link to the map (`src/encoder/Root.ts:224-259`), so the removed child keeps `parentTree` = map and `_parentIndex` = 5.
  - A later `view.add(child)` writes ADD@5 (`StateView.ts:638-657`), and `view.remove(child)` writes DELETE@5 (`StateView.ts:796-815`).
  - With recycling, both address the new occupant. Today they're harmless: the index is empty, so the drain turns them into a DELETE.
- **H3: reuse within the same tick.** DELETE + ADD at the same index merge into DELETE_AND_ADD. The Set filter would also read the new value instead of the `rec.deleted` snapshot (`SetSchema.ts:66`), so views that saw the old value would not get the DELETE. Reuse in the same tick must never happen.
- **H4: a DELETE that never shipped.**
  - `discard()` and `discardAllChanges` (`src/Schema.ts:427`) run `$onEncodeEnd` without encoding.
  - Untracked or paused deletes are never recorded (`MapSchema.ts:318`).
  - In both cases the client still holds the index.
- **H5: clients that still hold a stale occupant** (reconnect with resync, reconnect with a plain additive full sync, or a view that missed a DELETE).
  - Map: safe. Storage is keyed by key, and the new ADD overwrites `keyByIndex[5]`. Any ghost entry stays exactly as it would today.
  - Set and Stream: corrupt (§0, `Resync.ts:61-73`).
- **H6: iteration order.** The three `forEachLive` users walk in index order. Once indexes are recycled that is no longer insertion order, so the view bootstrap, `encodeAllView` and restage would deliver entries to the client in a different order from the server.
- **H7: streams.** Position state lives across ticks and views and is not in `rec.deleted`. `broadcastDeletes` flush only when there are no views (`Encoder.ts:225`), and resync never prunes. Out of scope.
- **H8 (existing, not caused by recycling): `MapSchema.clear()` restarts at 0 while a skipped view still holds `{5: DELETE}`.** V then deletes the post-clear occupant of index 5. Worth noting; the same gate could fix it later.
- **Checked and safe:**
  - Unreliable channel: collections can never be unreliable (`ChangeTree.ts:298-304`, `ChangeTree.ts:543`).
  - `@patchOnly` maps: skipped in full sync and resync (`liveIteration.ts:55`, `Resync.ts:136`); late joiners get a reused index as an ADD onto an empty slot.
  - A late joiner in the same tick: impossible, since reuse only happens after the harvest.
  - Detached maps: never enqueued, so never harvested (`Root.ts:246`).

## 3. The rule for freeing an index (MapSchema, v1)

**When an index can be reused.** Index *i* of map M goes into the free set when all of these hold:
- (a) it is in `rec.deleted` at `$onEncodeEnd` **of an encode pass** (`endEncode`, not `discard`);
- (b) the purge condition at `MapSchema.ts:454` holds, i.e. the key is really gone;
- (c) M is not a stream collection;
- (d) no active view holds `changes.get(M.refId)?.has(i)`.

Indexes that fail (d) go into a small `quarantine` array, re-checked at M's next `$onEncodeEnd`. Reuse is therefore never earlier than the next tick (H3), and never while a view is still waiting on the index (H1).

**Checking (d) cheaply.**
- `Encoder.discardChanges` bumps `root.encodeEpoch` before `discardQueue` (`Encoder.ts:738`).
- `root.viewsWithPendingChanges()` returns the views with `changes.size > 0`. It computes that list lazily, at most once per epoch, by collecting through `forEachActiveView`, which also prunes dead WeakRefs (`Root.ts:161-171`).
- The usual case is that every view drained this tick, so the list is empty and there is no per-index work.
- The cost is O(active views) once per tick, and only on ticks where some map freed an index.

**Closing H2 when entries are written.** In `addParentOf` and `remove`, for a numeric key under a Map parent, only write the entry if `parent[$getByIndex](parentIndex) === child.ref`, or if `rec.deleted?.get(parentIndex) === child.ref`.
- The second case keeps today's same-tick `view.remove` DELETE, which is needed because visibility has already been cleared by then.
- Anything else is a stale entry and is skipped. Today it ships as a harmless no-op DELETE; with this guard nothing ships.

**Which index to reuse: the lowest.** Use a free-index bitset:
- a `Uint32Array` that doubles in size to cover `nextIndex`, plus `count` and a `lowWord` cursor, with the invariant that every word below the cursor is 0;
- `push` sets the bit and does `lowWord = min(lowWord, word)`;
- `pop` scans forward from the cursor and takes `31 - clz32(w & -w)`;
- memory is `nextIndex/8` bytes, and `isFree` is O(1) for debug asserts.

Lowest-first keeps small maps under index 32, so their headers stay one byte even after a burst. A LIFO stack is simpler and bounds `nextIndex` just as well; the two only differ when the peak is far above the live size. A min-heap is O(log n) and has no advantage. Micro-bench the bitset against a stack before choosing.

**Where the free set lives: on `KeyedRecorder`.** Add `free?: FreeIndexes` and `quarantine?: number[]`, both `undefined` until the first harvest.
- The recorder is encoder-only, so decoder instances and MapSchema's shape don't change.
- `recycle()` (pooling, `KeyedRecorder.ts:150-155`) and `clear()` drop both.
- In `MapSchema.set`, the new-key branch becomes `const free = (tree.rec as KeyedRecorder|undefined)?.free; index = (free !== undefined && free.count !== 0) ? free.pop() : this.nextIndex++;`
- A map that never deletes pays one field load and an `undefined` compare. `delete()` pays nothing; the harvest rides on the existing `rec.deleted` loop at `MapSchema.ts:452`.

**The bound.** `nextIndex` ≤ the peak over ticks of (live entries + entries deleted in that tick + quarantined indexes).

## 4. Decoder

- **MapSchema: no change.** Neither the wire format nor the decoder changes. A reused index arrives as a plain ADD, and its key overwrites `keyByIndex[i]` (`DecodeOperation.ts:472`).
- **Set, Collection and Stream: a decoder change is required before recycling them.** An ADD onto an occupied index with a different value must overwrite the slot and drop the old `indexByValue` / `_itemIndex` entry, in `storeKeyValue` (`DecodeOperation.ts:521-534`) and on the Set side (`SetSchema.ts:242-246`).
- **Compatibility:** that is a wire behaviour change. It matches the spec, but existing clients would corrupt on reconnect. Ship the decoder fix first. Then recycle Set indexes only behind an explicit opt-in, or after a declared minimum client version.

## 5. Expected effect

**Bytes.** A keyed op header is 1 byte below index 32, 2 bytes below 8 192, and 3 bytes above. Full-sync bodies shrink too, because each entry writes `uvarint(index)` (`EncodeOperation.ts:927`).
- `encoder/map-churn` and `encoder/entity-churn` delete 10 entries in one tick and re-add 10 in the next (`bench/scenarios/encoder/map-churn.mjs:24-36`). That is 20 keyed headers per cycle, and today `nextIndex` grows by 10 per cycle.
- Past 8 192 those headers take 60 bytes per cycle. With recycling the indexes stay in `[0, n)`: about 34 bytes per cycle at n = 100 (32 % of them one-byte, the rest two-byte), and about 39 at n = 1000.
- Today the churn indexes cross 8 192 after (8192 − n)/10 cycles: **810 cycles** for n = 100 and **720** for n = 1000.
- `decoder/map-churn` generates about 1 501 cycles on 1 000 entries (`bench/scenarios/decoder/map-churn.mjs:23`), so it crosses at cycle 720.
- Before quoting a number, check how `i` and `setup` span warm-up and reps in `bench/lib`.
- New variants to add:
  - `str-16`: 16 live entries; today its indexes cross 32 after 2 cycles, while recycled ones stay at one byte;
  - `same-tick`: delete and re-add in one tick, so the peak is live + churn;
  - an ad-hoc run of 20 000 cycles.

**Memory.** The server-side `keyByIndex` RefTable, the KeyedRecorder `page0` and the decoder-side `keyByIndex` are all bounded by the peak live size instead of the lifetime count. The bitset costs at most `nextIndex/8` bytes.

**Hot path.**
- `set` on a new key: one extra load and compare.
- `$onEncodeEnd`: one bit set per purged index, plus the view scan once per epoch.
- `view.add` / `view.remove` under a Map parent: one `$getByIndex`.

**Bench rows.**
- Bytes: `encoder/map-churn` (all 4 variants), `encoder/entity-churn`, `decoder/map-churn` (both), `callbacks/map-churn`.
- Guards: `stateview/view-churn` (identity checks; it has no index churn, so its bytes should not change), plus the `mutations/*` and `tree-build/*` rows that call map `set`.

## 6. Tests and commits

**Tests.** Each uses the encoder with a real decoder, plus a `decodeResync` round-trip where it applies.
1. Churn for 10 000 cycles:
   - `nextIndex` stays ≤ live + churn;
   - the decoded state equals the server state;
   - header sizes shrink.
2. Delete and re-add in the same tick:
   - the same key keeps its index;
   - a different key gets a fresh index, never the one just freed.
3. StateView:
   - V is skipped for one tick while holding DELETE@i (or an ADD from `addParentOf`); i is not reused until V drains, and V never sees the new occupant;
   - `view.add` / `view.remove` of a removed child, after its index was reused, emits nothing;
   - a filtered map where view A sees i's old occupant and view B sees the new one.
4. Reconnect mid-churn:
   - resync leaves no ghosts, and `keyByIndex` agrees with `indexByKey`;
   - a plain additive full sync is no worse than today;
   - a late joiner's `encodeAll` / `encodeAllView` is correct at every phase of the cycle.
5. Lifecycle edges:
   - `clear()` with a pending free set or quarantine;
   - a pooled `$reset`;
   - `discardAllChanges` never frees an index.
6. A streamed map does not recycle indexes.
7. SetSchema, Collection and StreamSchema indexes stay monotonic in v1. Add a decoder test documenting the `storeKeyValue` overwrite behaviour, marked expected-to-fail until §4 lands.
8. Order: after reuse, the view bootstrap, `encodeAllView` and restage decode in the server's `$items` order.

**Commits.** Each is small, with its own frozen build and A/B compare.
1. `forEachLive` walks a map through `$items` + `indexByKey` (`liveIteration.ts:61-66`). Bytes should be identical except for keys re-set in the same tick; check with the byte guard.
2. `$onEncodeEnd(shipped)`, with `discard()` passing `false` (`ChangeTree.ts:998`). No behaviour change.
3. The write-time identity guard for keyed entries in StateView (`StateView.ts:654`, `StateView.ts:815`), plus the H2 tests.
4. The `FreeIndexes` bitset with unit tests, plus a micro-bench against a stack.
5. `Root.encodeEpoch` and `viewsWithPendingChanges()`.
6. MapSchema harvest, quarantine and allocation. `clear()` and `recycle()` drop the free set; streams are excluded.
7. Update the "never recycled" comments (`src/RefTable.ts:10-12`, `RefTable.ts:23-30`; `KeyedRecorder.ts:29-33`, `KeyedRecorder.ts:218`; `MapSchema.ts:39-46`).
8. New bench variants, then the full sweep.

## 7. Risks, and what to leave out of v1

**Risks.**
- Commit 1 can change bytes in `encodeAllView` and the view bootstrap for keys re-set in the same tick. The A/B byte guard will flag it.
- A view that writes `changes` before `_bindRoot` is not in `activeViews`, so check (d) would miss it. Confirm that `remove` either binds the view or rejects the call.
- A quarantined index waits for its map's next dirty tick. That only delays reuse; it is never wrong.
- External code may rely on indexes only growing: `nextIndex` and `keyByIndex` are public (`test/MapSchemaNumberKeys.test.ts:139`).
- KeyedRecorder's page drop assumes indexes only grow (`KeyedRecorder.ts:218-221`). It stays correct, because the pages it drops are all zeros.

**Left out of v1.**
- SetSchema and CollectionSchema: they need the §4 decoder fix and a compatibility gate.
- StreamSchema and `.stream()` maps (H7).
- Lowering `nextIndex` when the top indexes are free.
- Fixing H8 (`clear()` + a skipped view).

## Owner decisions

1. **Approve MapSchema-only v1?** The recommendation is yes: no wire or decoder change.
2. **SetSchema / CollectionSchema:**
   - (a) never recycle;
   - (b) ship the decoder fix now and recycle later, once a minimum client version can be assumed;
   - (c) recycle behind an opt-in.
3. **Commit 1 (`forEachLive` in `$items` order):** land it on its own? It makes the view bootstrap and `encodeAllView` follow insertion order even without recycling, which may also be desirable independently.
