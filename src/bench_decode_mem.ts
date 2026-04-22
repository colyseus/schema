import { PerformanceObserver, constants } from "node:perf_hooks";
import { Encoder, Decoder, Schema, type, MapSchema, ArraySchema } from "./index";

class Position extends Schema {
    @type("number") x: number;
    @type("number") y: number;
}

class Player extends Schema {
    @type("string") name: string;
    @type(Position) position = new Position();
    @type(["number"]) scores = new ArraySchema<number>();
}

class State extends Schema {
    @type({ map: Player }) players = new MapSchema<Player>();
}

if (!globalThis.gc) {
    console.error("Run with --expose-gc: npx tsx --expose-gc ...");
    process.exit(1);
}

Encoder.BUFFER_SIZE = 4096 * 4096;

// --- GC observer ---
const gcStats = { count: 0, totalMs: 0, majorMs: 0, minorMs: 0 };
const gcObserver = new PerformanceObserver((list) => {
    for (const e of list.getEntries() as any) {
        gcStats.count++;
        gcStats.totalMs += e.duration;
        if (e.detail?.kind === constants.NODE_PERFORMANCE_GC_MAJOR) gcStats.majorMs += e.duration;
        else gcStats.minorMs += e.duration;
    }
});
gcObserver.observe({ entryTypes: ["gc"], buffered: false });

function resetGc() { gcStats.count = 0; gcStats.totalMs = 0; gcStats.majorMs = 0; gcStats.minorMs = 0; }
function snapshotGc() { return { ...gcStats }; }
function heap() {
    globalThis.gc!();
    globalThis.gc!();
    return process.memoryUsage().heapUsed;
}
function mb(n: number) { return (n / 1024 / 1024).toFixed(2); }
function kb(n: number) { return (n / 1024).toFixed(1); }

// --- Build an encoder-side state once ---
const state = new State();
const encoder = new Encoder(state);
const N = 1000;
for (let i = 0; i < N; i++) {
    const p = new Player();
    p.name = `Player ${i}`;
    p.position.x = i;
    p.position.y = i;
    for (let j = 0; j < 5; j++) p.scores.push(j);
    state.players.set(`p${i}`, p);
}
const bootstrapBytes = encoder.encodeAll().slice();
encoder.discardChanges();

// Pre-produce steady-state frames (outside the timed region).
const heavyFrames: Uint8Array[] = [];
const HEAVY_TICKS = 200;
for (let i = 0; i < HEAVY_TICKS; i++) {
    for (let j = 0; j < N; j++) {
        const p = state.players.get(`p${j}`)!;
        p.position.x++;
        p.position.y++;
        p.scores[0] = i;
    }
    heavyFrames.push(encoder.encode().slice());
    encoder.discardChanges();
}

type Stats = {
    decoderHeapKb: number;
    steadyHeapDeltaKb: number;
    steadyGcCount: number;
    steadyGcMs: number;
    bootstrapMs: number;
    heavyMs: number;
};

function run(): Stats {
    const baseHeap = heap();

    const decoder = new Decoder(new State());
    const tBoot0 = performance.now();
    decoder.decode(bootstrapBytes);
    const bootstrapMs = performance.now() - tBoot0;

    const decoderHeap = heap() - baseHeap;

    resetGc();
    const beforeSteady = process.memoryUsage().heapUsed;
    const tHeavy0 = performance.now();
    for (let i = 0; i < HEAVY_TICKS; i++) decoder.decode(heavyFrames[i]);
    const heavyMs = performance.now() - tHeavy0;
    const afterSteady = process.memoryUsage().heapUsed;
    const gcSnap = snapshotGc();

    return {
        decoderHeapKb: decoderHeap / 1024,
        steadyHeapDeltaKb: (afterSteady - beforeSteady) / 1024,
        steadyGcCount: gcSnap.count,
        steadyGcMs: gcSnap.totalMs,
        bootstrapMs,
        heavyMs,
    };
}

// Warm (JIT seeding), discard result
run();

// Best-of-3 to get stable numbers
let best: Stats | undefined;
for (let i = 0; i < 3; i++) {
    const s = run();
    if (!best || s.heavyMs < best.heavyMs) best = s;
}

console.log("\n=== decoder memory + GC (best of 3) ===");
console.log(
    `bootstrap ${best!.bootstrapMs.toFixed(1)}ms | ` +
    `heavy ${HEAVY_TICKS}t ${best!.heavyMs.toFixed(1)}ms (${(best!.heavyMs / HEAVY_TICKS).toFixed(3)}ms/tick) | ` +
    `heap(decoder state, ${N} entities) ${kb(best!.decoderHeapKb * 1024)} KB | ` +
    `heap-growth/steady ${kb(best!.steadyHeapDeltaKb * 1024)} KB | ` +
    `GCs ${best!.steadyGcCount} (${best!.steadyGcMs.toFixed(1)}ms)`
);

// --- Multi-client scenario: 100 fresh decoders, each bootstrapped on the same bytes.
// Answers "how much heap does N simultaneous clients cost?".
function multiClient(numClients: number) {
    const baseHeap = heap();
    resetGc();
    const decoders: Decoder[] = [];
    const t0 = performance.now();
    for (let i = 0; i < numClients; i++) {
        const d = new Decoder(new State());
        d.decode(bootstrapBytes);
        decoders.push(d);
    }
    const elapsed = performance.now() - t0;
    const gcSnap = snapshotGc();
    const heapAfter = heap();
    return {
        decoders, // keep alive so GC can't reclaim during measurement
        totalHeapKb: (heapAfter - baseHeap) / 1024,
        elapsedMs: elapsed,
        gcCount: gcSnap.count,
        gcMs: gcSnap.totalMs,
    };
}

console.log(`\n=== multi-client bootstrap (100 decoders, ${N} entities each) ===`);
const mc = multiClient(100);
console.log(
    `${mc.elapsedMs.toFixed(0)}ms | ` +
    `heap ${mb(mc.totalHeapKb * 1024)} MB | ` +
    `GCs ${mc.gcCount} (${mc.gcMs.toFixed(1)}ms)`
);

gcObserver.disconnect();
