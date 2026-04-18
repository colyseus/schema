/**
 * bench_view_cmp.ts — StateView-path counterpart to bench_bloat.ts.
 *
 * Same entity layout (1000 players × Position × 5 scores) but with N
 * StateViews subscribing to a @view-tagged secret field on each player.
 * Measures per-tick encode throughput under view-filtered fanout.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json --expose-gc src/bench_view_cmp.ts
 */
import { Encoder, Schema, type, view, MapSchema, ArraySchema, StateView } from "./index";

class Position extends Schema {
    @type("number") x: number = 0;
    @type("number") y: number = 0;
}

class Player extends Schema {
    @type("string") name: string = "";
    @type(Position) position = new Position();
    @type(["number"]) scores = new ArraySchema<number>();
    @view() @type("uint32") secret: number = 0;
}

class State extends Schema {
    @type({ map: Player }) players = new MapSchema<Player>();
}

const N_PLAYERS = 1000;
const N_CLIENTS = 10;

// ─── Setup ─────────────────────────────────────────────────────────────

globalThis.gc?.();
const heapBefore = process.memoryUsage().heapUsed;

const state = new State();
const encoder = new Encoder(state);
Encoder.BUFFER_SIZE = 256 * 1024;

for (let i = 0; i < N_PLAYERS; i++) {
    const p = new Player();
    p.name = `P${i}`;
    p.position.x = i;
    p.position.y = i;
    for (let j = 0; j < 5; j++) p.scores.push(j);
    p.secret = i;
    state.players.set(`p${i}`, p);
}

globalThis.gc?.();
const heapAfter = process.memoryUsage().heapUsed;
console.log(`Heap (${N_PLAYERS} players): ${((heapAfter - heapBefore) / 1024 / 1024).toFixed(2)} MB`);

// Subscribe N clients, each to every player.
const views: StateView[] = [];
for (let c = 0; c < N_CLIENTS; c++) {
    const v = new StateView();
    for (let i = 0; i < N_PLAYERS; i++) {
        v.add(state.players.get(`p${i}`)!);
    }
    views.push(v);
}

// Bootstrap full encode.
encoder.encodeAll();
for (const v of views) {
    const it = { offset: 0 };
    encoder.encodeAll(it);
    encoder.encodeAllView(v, it.offset, it);
}
encoder.discardChanges();

// ─── 1. 10-mutation ticks ──────────────────────────────────────────────

{
    const iterations = 2000;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
        for (let j = 0; j < 10; j++) {
            const p = state.players.get(`p${j}`)!;
            p.position.x++;
            p.position.y++;
        }
        const it = { offset: 0 };
        encoder.encode(it);
        const sharedOffset = it.offset;
        for (const v of views) encoder.encodeView(v, sharedOffset, it);
        encoder.discardChanges();
    }
    const elapsed = performance.now() - start;
    console.log(
        `${iterations} ticks × (10 mutations, shared + ${N_CLIENTS} views): ` +
        `${elapsed.toFixed(1)}ms total (${(elapsed / iterations).toFixed(4)}ms/tick)`,
    );
}

// ─── 2. 100-mutation ticks ─────────────────────────────────────────────

{
    const iterations = 500;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
        for (let j = 0; j < 100; j++) {
            const p = state.players.get(`p${j}`)!;
            p.position.x++;
            p.position.y++;
        }
        const it = { offset: 0 };
        encoder.encode(it);
        const sharedOffset = it.offset;
        for (const v of views) encoder.encodeView(v, sharedOffset, it);
        encoder.discardChanges();
    }
    const elapsed = performance.now() - start;
    console.log(
        `${iterations} ticks × (100 mutations, shared + ${N_CLIENTS} views): ` +
        `${elapsed.toFixed(1)}ms total (${(elapsed / iterations).toFixed(3)}ms/tick)`,
    );
}

// ─── 3. View-tagged field mutations (exercises per-view filtering) ─────

{
    const iterations = 500;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
        for (let j = 0; j < 100; j++) {
            const p = state.players.get(`p${j}`)!;
            p.secret = (p.secret + 1) >>> 0;
        }
        const it = { offset: 0 };
        encoder.encode(it);
        const sharedOffset = it.offset;
        for (const v of views) encoder.encodeView(v, sharedOffset, it);
        encoder.discardChanges();
    }
    const elapsed = performance.now() - start;
    console.log(
        `${iterations} ticks × (100 @view-field mutations, shared + ${N_CLIENTS} views): ` +
        `${elapsed.toFixed(1)}ms total (${(elapsed / iterations).toFixed(3)}ms/tick)`,
    );
}
