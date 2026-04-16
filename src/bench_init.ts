/**
 * Benchmark: Schema instance initialization throughput.
 *
 * Measures how fast schema instances can be created. The main hot path is
 * Schema.initialize() — which allocates $changes and $values per instance.
 *
 * Usage (current branch):
 *   npx tsx --tsconfig tsconfig.test.json bench_init.ts
 *
 * Usage (previous version — run from the sibling checkout):
 *   cd ../schema && npx tsx --tsconfig tsconfig.test.json ../schema-5.0/bench_init.ts
 *
 * The benchmark uses the same schema hierarchy as bench_encode.js so results
 * are directly comparable.
 */
import { Schema, type, ArraySchema, MapSchema, Encoder } from "./index";

class Attribute extends Schema {
    @type("string") name: string;
    @type("number") value: number;
}

class Item extends Schema {
    @type("number") price: number;
    @type([Attribute]) attributes = new ArraySchema<Attribute>();
}

class Position extends Schema {
    @type("number") x: number;
    @type("number") y: number;
}

class Player extends Schema {
    @type(Position) position = new Position();
    @type({ map: Item }) items = new MapSchema<Item>();
}

class State extends Schema {
    @type({ map: Player }) players = new MapSchema<Player>();
    @type("string") currentTurn: string;
}

// ---------------------------------------------------------------------------
// Warmup — let V8 JIT the constructors
// ---------------------------------------------------------------------------
for (let i = 0; i < 500; i++) {
    const p = new Player();
    p.position.x = i;
    const item = new Item();
    const attr = new Attribute();
    attr.name = "warmup";
    attr.value = i;
    item.attributes.push(attr);
    p.items.set("w", item);
}

// ---------------------------------------------------------------------------
// Benchmark 1: Raw instance creation (no encoder, no parent wiring)
// ---------------------------------------------------------------------------
const INSTANCES = 50_000;

globalThis.gc?.();
const t0 = performance.now();
const players: Player[] = new Array(INSTANCES);
for (let i = 0; i < INSTANCES; i++) {
    players[i] = new Player();
}
const t1 = performance.now();
console.log(`\n--- Raw instance creation (${INSTANCES} Player instances) ---`);
console.log(`Total: ${(t1 - t0).toFixed(2)} ms`);
console.log(`Per instance: ${((t1 - t0) / INSTANCES * 1000).toFixed(2)} µs`);

// ---------------------------------------------------------------------------
// Benchmark 2: Deep hierarchy creation (Player + Position + 10 Items × 5 Attributes)
// ---------------------------------------------------------------------------
const DEEP_COUNT = 5_000;

globalThis.gc?.();
const t2 = performance.now();
for (let i = 0; i < DEEP_COUNT; i++) {
    const player = new Player();
    player.position.x = i;
    player.position.y = i;
    for (let j = 0; j < 10; j++) {
        const item = new Item();
        item.price = j * 50;
        for (let k = 0; k < 5; k++) {
            const attr = new Attribute();
            attr.name = `Attribute ${k}`;
            attr.value = k;
            item.attributes.push(attr);
        }
        player.items.set(`item-${j}`, item);
    }
}
const t3 = performance.now();
const totalInstances = DEEP_COUNT * (1 /* Player */ + 1 /* Position */ + 10 /* Items */ + 50 /* Attributes */);
console.log(`\n--- Deep hierarchy creation (${DEEP_COUNT} trees, ${totalInstances} total instances) ---`);
console.log(`Total: ${(t3 - t2).toFixed(2)} ms`);
console.log(`Per tree: ${((t3 - t2) / DEEP_COUNT * 1000).toFixed(2)} µs`);
console.log(`Per instance: ${((t3 - t2) / totalInstances * 1000).toFixed(2)} µs`);

// ---------------------------------------------------------------------------
// Benchmark 3: Full encode cycle (matches bench_encode.js structure)
// ---------------------------------------------------------------------------
const state = new State();
Encoder.BUFFER_SIZE = 4096 * 4096;
const encoder = new Encoder(state);

const ROUNDS = 50;
const PLAYERS_PER_ROUND = 50;

globalThis.gc?.();
let totalMakeChanges = 0;
let totalEncode = 0;

for (let i = 0; i < ROUNDS; i++) {
    const mc0 = performance.now();
    for (let j = 0; j < PLAYERS_PER_ROUND; j++) {
        const player = new Player();
        state.players.set(`p-${i}-${j}`, player);
        player.position.x = (j + 1) * 100;
        player.position.y = (j + 1) * 100;
        for (let k = 0; k < 10; k++) {
            const item = new Item();
            item.price = (j + 1) * 50;
            for (let l = 0; l < 5; l++) {
                const attr = new Attribute();
                attr.name = `Attribute ${l}`;
                attr.value = l;
                item.attributes.push(attr);
            }
            player.items.set(`item-${k}`, item);
        }
    }
    const mc1 = performance.now();
    totalMakeChanges += mc1 - mc0;

    const enc0 = performance.now();
    encoder.encode();
    encoder.discardChanges();
    const enc1 = performance.now();
    totalEncode += enc1 - enc0;
}

console.log(`\n--- Encode cycle (${ROUNDS} rounds × ${PLAYERS_PER_ROUND} players) ---`);
console.log(`Avg make changes: ${(totalMakeChanges / ROUNDS).toFixed(2)} ms`);
console.log(`Avg encode:       ${(totalEncode / ROUNDS).toFixed(2)} ms`);
console.log(`Total:            ${(totalMakeChanges + totalEncode).toFixed(2)} ms`);
console.log(`Encoded size:     ${Array.from(encoder.encodeAll()).length} bytes`);
