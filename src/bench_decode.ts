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

function freshDecoder() {
    return new Decoder(new State());
}

function clone(bytes: Uint8Array) {
    return bytes.slice();
}

Encoder.BUFFER_SIZE = 4096 * 4096;

// --- Build a server state with N entities ---
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

// --- Measure 1: Initial bootstrap decode (encodeAll on a fresh client) ---
{
    const bootstrapBytes = clone(encoder.encodeAll());
    encoder.discardChanges();

    const iterations = 200;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
        const decoder = freshDecoder();
        decoder.decode(bootstrapBytes);
    }
    const elapsed = performance.now() - start;
    console.log(
        `Bootstrap decode (${N} entities) x${iterations}: ${elapsed.toFixed(1)}ms ` +
        `(${(elapsed / iterations).toFixed(3)}ms/run, ${bootstrapBytes.length} bytes)`
    );
}

// --- Measure 2: Steady-state small-tick decode (10 players per tick) ---
{
    const decoder = freshDecoder();
    decoder.decode(clone(encoder.encodeAll()));
    encoder.discardChanges();

    const ticks = 5000;
    // Pre-produce the byte frames so we measure decode only.
    const frames: Uint8Array[] = new Array(ticks);
    for (let i = 0; i < ticks; i++) {
        for (let j = 0; j < 10; j++) {
            const p = state.players.get(`p${j}`)!;
            p.position.x++;
            p.position.y++;
        }
        frames[i] = clone(encoder.encode());
        encoder.discardChanges();
    }

    const start = performance.now();
    for (let i = 0; i < ticks; i++) decoder.decode(frames[i]);
    const elapsed = performance.now() - start;
    const totalBytes = frames.reduce((s, f) => s + f.length, 0);
    console.log(
        `Small-tick decode (10 mutations/tick) x${ticks}: ${elapsed.toFixed(1)}ms ` +
        `(${(elapsed / ticks).toFixed(4)}ms/tick, avg ${(totalBytes / ticks).toFixed(1)} bytes/tick)`
    );
}

// --- Measure 3: Steady-state large-tick decode (100 players per tick) ---
{
    const decoder = freshDecoder();
    decoder.decode(clone(encoder.encodeAll()));
    encoder.discardChanges();

    const ticks = 1000;
    const frames: Uint8Array[] = new Array(ticks);
    for (let i = 0; i < ticks; i++) {
        for (let j = 0; j < 100; j++) {
            const p = state.players.get(`p${j}`)!;
            p.position.x++;
            p.position.y++;
        }
        frames[i] = clone(encoder.encode());
        encoder.discardChanges();
    }

    const start = performance.now();
    for (let i = 0; i < ticks; i++) decoder.decode(frames[i]);
    const elapsed = performance.now() - start;
    const totalBytes = frames.reduce((s, f) => s + f.length, 0);
    console.log(
        `Large-tick decode (100 mutations/tick) x${ticks}: ${elapsed.toFixed(1)}ms ` +
        `(${(elapsed / ticks).toFixed(3)}ms/tick, avg ${(totalBytes / ticks).toFixed(1)} bytes/tick)`
    );
}

// --- Measure 4: Add/remove churn decode ---
{
    const churnState = new State();
    const churnEncoder = new Encoder(churnState);
    for (let i = 0; i < 100; i++) {
        const p = new Player();
        p.name = `P${i}`;
        p.position.x = i;
        p.position.y = i;
        churnState.players.set(`p${i}`, p);
    }

    const decoder = new Decoder(new State());
    decoder.decode(clone(churnEncoder.encodeAll()));
    churnEncoder.discardChanges();

    const cycles = 1000;
    const frames: Uint8Array[] = [];
    for (let i = 0; i < cycles; i++) {
        for (let j = 0; j < 10; j++) {
            const key = `p${(i * 10 + j) % 100}`;
            churnState.players.delete(key);
        }
        frames.push(clone(churnEncoder.encode()));
        churnEncoder.discardChanges();
        for (let j = 0; j < 10; j++) {
            const key = `p${(i * 10 + j) % 100}`;
            const p = new Player();
            p.name = key;
            p.position.x = i;
            p.position.y = j;
            churnState.players.set(key, p);
        }
        frames.push(clone(churnEncoder.encode()));
        churnEncoder.discardChanges();
    }

    const start = performance.now();
    for (let i = 0; i < frames.length; i++) decoder.decode(frames[i]);
    const elapsed = performance.now() - start;
    console.log(
        `Churn decode (${cycles} cycles, 10 remove+add each, ${frames.length} frames): ` +
        `${elapsed.toFixed(1)}ms (${(elapsed / cycles).toFixed(3)}ms/cycle)`
    );
}

// --- Measure 5: Array push/pop churn decode ---
{
    class ArrayState extends Schema {
        @type(["number"]) items = new ArraySchema<number>();
    }
    const arrayState = new ArrayState();
    const arrayEncoder = new Encoder(arrayState);
    for (let i = 0; i < 100; i++) arrayState.items.push(i);

    const decoder = new Decoder(new ArrayState());
    decoder.decode(clone(arrayEncoder.encodeAll()));
    arrayEncoder.discardChanges();

    const ticks = 5000;
    const frames: Uint8Array[] = new Array(ticks);
    for (let i = 0; i < ticks; i++) {
        arrayState.items.push(100 + i);
        arrayState.items.pop();
        frames[i] = clone(arrayEncoder.encode());
        arrayEncoder.discardChanges();
    }

    const start = performance.now();
    for (let i = 0; i < ticks; i++) decoder.decode(frames[i]);
    const elapsed = performance.now() - start;
    console.log(
        `Array push/pop decode x${ticks}: ${elapsed.toFixed(1)}ms ` +
        `(${(elapsed / ticks).toFixed(4)}ms/tick)`
    );
}

// --- Measure 6: Heavy mutation per tick (every player + array items) ---
{
    const decoder = freshDecoder();
    decoder.decode(clone(encoder.encodeAll()));
    encoder.discardChanges();

    const ticks = 200;
    const frames: Uint8Array[] = new Array(ticks);
    for (let i = 0; i < ticks; i++) {
        for (let j = 0; j < N; j++) {
            const p = state.players.get(`p${j}`)!;
            p.position.x++;
            p.position.y++;
            p.scores[0] = i;
        }
        frames[i] = clone(encoder.encode());
        encoder.discardChanges();
    }

    const start = performance.now();
    for (let i = 0; i < ticks; i++) decoder.decode(frames[i]);
    const elapsed = performance.now() - start;
    const totalBytes = frames.reduce((s, f) => s + f.length, 0);
    console.log(
        `Heavy-tick decode (${N} players touched) x${ticks}: ${elapsed.toFixed(1)}ms ` +
        `(${(elapsed / ticks).toFixed(3)}ms/tick, avg ${(totalBytes / ticks).toFixed(0)} bytes/tick)`
    );
}
