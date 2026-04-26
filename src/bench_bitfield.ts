/**
 * Bitfield vs separate-fields benchmark.
 *
 * Compares two equivalent schemas:
 *   - Wide:   8 separate `t.bool()` fields + 2 separate `t.uint8()` fields.
 *   - Packed: 1 `t.bitfield(...)` slot holding 8 bools + 2 narrow uints (4-bit each).
 *
 * Reports wire size, per-tick encode/decode time, and per-instance memory.
 */
import { Encoder, Decoder, Reflection, schema, t } from "./index";

Encoder.BUFFER_SIZE = 4 * 1024 * 1024;

const ENTITY_COUNT = 1000;
const TICKS = 5000;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const Wide = schema({
    a: t.bool(), b: t.bool(), c: t.bool(), d: t.bool(),
    e: t.bool(), f: t.bool(), g: t.bool(), h: t.bool(),
    klass: t.uint8(),
    stage: t.uint8(),
}, "Wide");

const Packed = schema({
    flags: t.bitfield({
        a: t.bool(), b: t.bool(), c: t.bool(), d: t.bool(),
        e: t.bool(), f: t.bool(), g: t.bool(), h: t.bool(),
        klass: t.uint(4),
        stage: t.uint(4),
    }),
}, "Packed");

const RoomWide = schema({
    items: t.array(Wide),
}, "RoomWide");

const RoomPacked = schema({
    items: t.array(Packed),
}, "RoomPacked");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fillWide(room: any) {
    for (let i = 0; i < ENTITY_COUNT; i++) {
        const w = new Wide();
        w.a = true; w.c = true; w.e = true; w.g = true;
        w.klass = i & 15;
        w.stage = (i >> 4) & 15;
        room.items.push(w);
    }
}

function fillPacked(room: any) {
    for (let i = 0; i < ENTITY_COUNT; i++) {
        const p = new Packed();
        p.flags.a = true; p.flags.c = true; p.flags.e = true; p.flags.g = true;
        p.flags.klass = i & 15;
        p.flags.stage = (i >> 4) & 15;
        room.items.push(p);
    }
}

function mutateWide(room: any, n: number) {
    for (let i = 0; i < n; i++) {
        const w = room.items[i];
        w.a = !w.a;
        w.klass = (w.klass + 1) & 15;
    }
}

function mutatePacked(room: any, n: number) {
    for (let i = 0; i < n; i++) {
        const p = room.items[i];
        p.flags.a = !p.flags.a;
        p.flags.klass = (p.flags.klass + 1) & 15;
    }
}

function timeIt(fn: () => void): number {
    const start = performance.now();
    fn();
    return performance.now() - start;
}

function makeDecoder(room: any) {
    const encoder = new Encoder(room);
    const decoder = Reflection.decode(Reflection.encode(encoder));
    return { encoder, decoder };
}

// ---------------------------------------------------------------------------
// Wire size — initial full sync
// ---------------------------------------------------------------------------

{
    const wideRoom = new RoomWide();
    fillWide(wideRoom);
    const wideEncoder = new Encoder(wideRoom);
    const wideAll = wideEncoder.encodeAll();

    const packedRoom = new RoomPacked();
    fillPacked(packedRoom);
    const packedEncoder = new Encoder(packedRoom);
    const packedAll = packedEncoder.encodeAll();

    console.log("=== Wire size: full sync (1000 entities) ===");
    console.log(`  Wide   (8 bool + 2 uint8 separate): ${wideAll.length.toString()} bytes`);
    console.log(`  Packed (1 bitfield, same data):     ${packedAll.length.toString()} bytes`);
    console.log(`  Saved: ${(wideAll.length - packedAll.length).toString()} bytes (${(100 * (wideAll.length - packedAll.length) / wideAll.length).toFixed(1)}%)`);
    console.log();
}

// ---------------------------------------------------------------------------
// Wire size — per-tick patch (mutate 100 entities)
// ---------------------------------------------------------------------------

{
    const wideRoom = new RoomWide();
    fillWide(wideRoom);
    const wideEncoder = new Encoder(wideRoom);
    wideEncoder.encodeAll(); // discard initial
    wideEncoder.discardChanges();
    mutateWide(wideRoom, 100);
    const widePatch = wideEncoder.encode();

    const packedRoom = new RoomPacked();
    fillPacked(packedRoom);
    const packedEncoder = new Encoder(packedRoom);
    packedEncoder.encodeAll();
    packedEncoder.discardChanges();
    mutatePacked(packedRoom, 100);
    const packedPatch = packedEncoder.encode();

    console.log("=== Wire size: per-tick patch (100 entities mutated) ===");
    console.log(`  Wide   (toggle 1 bool + 1 uint8 each): ${widePatch.length.toString()} bytes`);
    console.log(`  Packed (same mutations on bitfield):    ${packedPatch.length.toString()} bytes`);
    console.log(`  Saved: ${(widePatch.length - packedPatch.length).toString()} bytes (${(100 * (widePatch.length - packedPatch.length) / widePatch.length).toFixed(1)}%)`);
    console.log();
}

// ---------------------------------------------------------------------------
// Encode tick speed
// ---------------------------------------------------------------------------

{
    const wideRoom = new RoomWide();
    fillWide(wideRoom);
    const wideEncoder = new Encoder(wideRoom);
    wideEncoder.encodeAll();
    wideEncoder.discardChanges();

    const wideMs = timeIt(() => {
        for (let i = 0; i < TICKS; i++) {
            mutateWide(wideRoom, 100);
            wideEncoder.encode();
            wideEncoder.discardChanges();
        }
    });

    const packedRoom = new RoomPacked();
    fillPacked(packedRoom);
    const packedEncoder = new Encoder(packedRoom);
    packedEncoder.encodeAll();
    packedEncoder.discardChanges();

    const packedMs = timeIt(() => {
        for (let i = 0; i < TICKS; i++) {
            mutatePacked(packedRoom, 100);
            packedEncoder.encode();
            packedEncoder.discardChanges();
        }
    });

    console.log(`=== Encode tick speed (${TICKS} ticks, 100 mutations each) ===`);
    console.log(`  Wide:   ${wideMs.toFixed(1)} ms total  (${(wideMs / TICKS * 1000).toFixed(1)} µs/tick)`);
    console.log(`  Packed: ${packedMs.toFixed(1)} ms total  (${(packedMs / TICKS * 1000).toFixed(1)} µs/tick)`);
    console.log(`  Speedup: ${(wideMs / packedMs).toFixed(2)}x`);
    console.log();
}

// ---------------------------------------------------------------------------
// Decode tick speed
// ---------------------------------------------------------------------------

{
    const wideRoom = new RoomWide();
    fillWide(wideRoom);
    const { encoder: wideEncoder, decoder: wideDecoder } = makeDecoder(wideRoom);
    wideDecoder.decode(wideEncoder.encodeAll());
    wideEncoder.discardChanges();

    const wideMs = timeIt(() => {
        for (let i = 0; i < TICKS; i++) {
            mutateWide(wideRoom, 100);
            wideDecoder.decode(wideEncoder.encode());
            wideEncoder.discardChanges();
        }
    });

    const packedRoom = new RoomPacked();
    fillPacked(packedRoom);
    const { encoder: packedEncoder, decoder: packedDecoder } = makeDecoder(packedRoom);
    packedDecoder.decode(packedEncoder.encodeAll());
    packedEncoder.discardChanges();

    const packedMs = timeIt(() => {
        for (let i = 0; i < TICKS; i++) {
            mutatePacked(packedRoom, 100);
            packedDecoder.decode(packedEncoder.encode());
            packedEncoder.discardChanges();
        }
    });

    console.log(`=== Encode + Decode tick speed (${TICKS} ticks, 100 mutations each) ===`);
    console.log(`  Wide:   ${wideMs.toFixed(1)} ms total  (${(wideMs / TICKS * 1000).toFixed(1)} µs/tick)`);
    console.log(`  Packed: ${packedMs.toFixed(1)} ms total  (${(packedMs / TICKS * 1000).toFixed(1)} µs/tick)`);
    console.log(`  Speedup: ${(wideMs / packedMs).toFixed(2)}x`);
    console.log();
}

// ---------------------------------------------------------------------------
// Memory: per-instance heap delta
// ---------------------------------------------------------------------------

{
    globalThis.gc?.();
    const beforeWide = process.memoryUsage().heapUsed;
    const wideRoom = new RoomWide();
    fillWide(wideRoom);
    new Encoder(wideRoom).encodeAll();
    globalThis.gc?.();
    const wideHeap = process.memoryUsage().heapUsed - beforeWide;

    globalThis.gc?.();
    const beforePacked = process.memoryUsage().heapUsed;
    const packedRoom = new RoomPacked();
    fillPacked(packedRoom);
    new Encoder(packedRoom).encodeAll();
    globalThis.gc?.();
    const packedHeap = process.memoryUsage().heapUsed - beforePacked;

    console.log(`=== Heap (${ENTITY_COUNT} entities, encoder + state) ===`);
    console.log(`  Wide:   ${(wideHeap / 1024).toFixed(1)} KB  (${(wideHeap / ENTITY_COUNT).toFixed(0)} bytes/entity)`);
    console.log(`  Packed: ${(packedHeap / 1024).toFixed(1)} KB  (${(packedHeap / ENTITY_COUNT).toFixed(0)} bytes/entity)`);
    console.log();
}
