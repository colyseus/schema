import { Encoder, Schema, type, MapSchema, ArraySchema } from "./index";

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

// --- Measure 1: Memory ---
globalThis.gc?.();
const heapBefore = process.memoryUsage().heapUsed;

const state = new State();
const encoder = new Encoder(state);

for (let i = 0; i < 1000; i++) {
    const p = new Player();
    p.name = `Player ${i}`;
    p.position.x = i;
    p.position.y = i;
    for (let j = 0; j < 5; j++) p.scores.push(j);
    state.players.set(`p${i}`, p);
}

globalThis.gc?.();
const heapAfter = process.memoryUsage().heapUsed;
console.log(`Heap delta (1000 entities): ${((heapAfter - heapBefore) / 1024 / 1024).toFixed(2)} MB`);

// Initial encode
encoder.encode();
encoder.discardChanges();

// --- Measure 2: Encode tick speed (small mutations) ---
const iterations = 5000;
const start = performance.now();
for (let i = 0; i < iterations; i++) {
    // Mutate 10 players (small tick)
    for (let j = 0; j < 10; j++) {
        const p = state.players.get(`p${j}`);
        p.position.x++;
        p.position.y++;
    }
    encoder.encode();
    encoder.discardChanges();
}
const elapsed = performance.now() - start;
console.log(`${iterations} encode ticks (10 mutations each): ${elapsed.toFixed(1)}ms (${(elapsed/iterations).toFixed(4)}ms/tick)`);

// --- Measure 3: Encode tick speed (large mutations) ---
const iterations2 = 1000;
const start2 = performance.now();
for (let i = 0; i < iterations2; i++) {
    for (let j = 0; j < 100; j++) {
        const p = state.players.get(`p${j}`);
        p.position.x++;
        p.position.y++;
    }
    encoder.encode();
    encoder.discardChanges();
}
const elapsed2 = performance.now() - start2;
console.log(`${iterations2} encode ticks (100 mutations each): ${elapsed2.toFixed(1)}ms (${(elapsed2/iterations2).toFixed(3)}ms/tick)`);

// --- Measure 4: Entity creation speed ---
const state2 = new State();
const encoder2 = new Encoder(state2);
const createStart = performance.now();
for (let i = 0; i < 5000; i++) {
    const p = new Player();
    p.name = `P${i}`;
    p.position.x = i;
    p.position.y = i;
    state2.players.set(`p${i}`, p);
}
const createElapsed = performance.now() - createStart;
console.log(`Create 5000 entities: ${createElapsed.toFixed(1)}ms`);

// --- Measure 5: encodeAll speed ---
Encoder.BUFFER_SIZE = 4096 * 4096;
const encoder3 = new Encoder(state2);
const encodeAllStart = performance.now();
for (let i = 0; i < 100; i++) {
    encoder3.encodeAll();
}
const encodeAllElapsed = performance.now() - encodeAllStart;
console.log(`100x encodeAll (5000 entities): ${encodeAllElapsed.toFixed(1)}ms`);

// --- Measure 6: GC pressure (heap growth over many ticks) ---
globalThis.gc?.();
const gcBefore = process.memoryUsage().heapUsed;
for (let i = 0; i < 10000; i++) {
    const p = state.players.get(`p${i % 100}`);
    p.position.x++;
    p.position.y++;
    if (i % 10 === 0) {
        encoder.encode();
        encoder.discardChanges();
    }
}
globalThis.gc?.();
const gcAfter = process.memoryUsage().heapUsed;
console.log(`GC pressure (10k mutations, 1k encode ticks): heap delta ${((gcAfter - gcBefore) / 1024).toFixed(1)} KB`);

// --- Measure 7: Entity add/remove churn (exercises Root linked list) ---
const churnState = new State();
const churnEncoder = new Encoder(churnState);
// Pre-populate
for (let i = 0; i < 100; i++) {
    const p = new Player();
    p.name = `P${i}`;
    p.position.x = i;
    p.position.y = i;
    churnState.players.set(`p${i}`, p);
}
churnEncoder.encode();
churnEncoder.discardChanges();

const churnStart = performance.now();
for (let i = 0; i < 1000; i++) {
    // Remove and re-add 10 entities
    for (let j = 0; j < 10; j++) {
        const key = `p${(i * 10 + j) % 100}`;
        churnState.players.delete(key);
    }
    churnEncoder.encode();
    churnEncoder.discardChanges();
    for (let j = 0; j < 10; j++) {
        const key = `p${(i * 10 + j) % 100}`;
        const p = new Player();
        p.name = key;
        p.position.x = i;
        p.position.y = j;
        churnState.players.set(key, p);
    }
    churnEncoder.encode();
    churnEncoder.discardChanges();
}
const churnElapsed = performance.now() - churnStart;
console.log(`1000 entity churn cycles (10 remove+add each): ${churnElapsed.toFixed(1)}ms (${(churnElapsed/1000).toFixed(3)}ms/cycle)`);

// --- Measure 9: Array push/pop churn ---
class ArrayState extends Schema {
    @type(["number"]) items = new ArraySchema<number>();
}
const arrayState = new ArrayState();
const arrayEncoder = new Encoder(arrayState);
for (let i = 0; i < 100; i++) arrayState.items.push(i);
arrayEncoder.encode();
arrayEncoder.discardChanges();

const arrayStart = performance.now();
for (let i = 0; i < 5000; i++) {
    arrayState.items.push(100 + i);
    arrayState.items.pop();
    arrayEncoder.encode();
    arrayEncoder.discardChanges();
}
const arrayElapsed = performance.now() - arrayStart;
console.log(`5000 array push/pop ticks: ${arrayElapsed.toFixed(1)}ms (${(arrayElapsed/5000).toFixed(4)}ms/tick)`);
