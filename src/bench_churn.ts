/**
 * Benchmark: entity churn (spawn → despawn → respawn) with and without the
 * native SchemaPool. Existing benches (bench_encode/bench_bloat) are
 * monotonic-growth and never return instances to a pool, so they can't show
 * pooling ROI — this one models the ECS/projectile/bot workload the pool
 * targets.
 *
 * Usage:  npx tsx --tsconfig tsconfig.test.json src/bench_churn.ts
 */
import v8 from "node:v8";
import vm from "node:vm";
import { Schema, type, MapSchema, Encoder, createPool, type SchemaPool } from "./index";

// gc() handle (works under the tsx CLI, where `node --expose-gc` doesn't reach
// the forked child).
v8.setFlagsFromString("--expose-gc");
const gc = (globalThis.gc as undefined | (() => void)) ?? (vm.runInNewContext("gc") as () => void);

class Vector extends Schema {
    @type("number") x: number = 0;
    @type("number") y: number = 0;
    @type("number") z: number = 0;
}
// A nested entity: Entity + 2 child Vectors = 3 Schema instances per spawn,
// matching the miniplex profiling scenario.
class Entity extends Schema {
    @type("string") name: string = "";
    @type(Vector) position = new Vector();
    @type(Vector) velocity = new Vector();
}
class State extends Schema {
    @type({ map: Entity }) entities = new MapSchema<Entity>();
}

Encoder.BUFFER_SIZE = 4096 * 4096;

const N = 2_000;     // entities alive per tick
const TICKS = 200;   // churn cycles
const WARMUP = 10;
const INSTANCES_PER_ENTITY = 3; // Entity + position + velocity
const spawns = N * TICKS;

const heap = () => {
    gc?.();
    gc?.();
    return process.memoryUsage().heapUsed;
};

function runChurn(usePool: boolean) {
    const state = new State();
    const encoder = new Encoder(state);
    encoder.encode();
    encoder.discardChanges();

    const pool: SchemaPool<Entity> | undefined = usePool ? createPool(Entity, { preallocate: N }) : undefined;
    const live: Entity[] = new Array(N);

    const spawnTick = (timeConstruct: boolean): number => {
        // CONSTRUCTION phase (the differentiator): new vs acquire
        const c0 = performance.now();
        for (let i = 0; i < N; i++) {
            live[i] = pool ? pool.acquire() : new Entity();
        }
        const c1 = performance.now();

        // init + attach + encode
        for (let i = 0; i < N; i++) {
            const e = live[i];
            e.name = "e" + i;
            e.position.x = i; e.position.y = i; e.position.z = i;
            e.velocity.x = 1;
            state.entities.set(String(i), e);
        }
        encoder.encode();
        encoder.discardChanges();

        // despawn + release
        for (let i = 0; i < N; i++) state.entities.delete(String(i));
        encoder.encode();
        encoder.discardChanges();
        if (pool) for (let i = 0; i < N; i++) pool.release(live[i]);

        return timeConstruct ? c1 - c0 : 0;
    };

    for (let t = 0; t < WARMUP; t++) spawnTick(false);

    const before = heap();
    let constructMs = 0;
    const t0 = performance.now();
    for (let t = 0; t < TICKS; t++) constructMs += spawnTick(true);
    const t1 = performance.now();
    const after = heap();

    return {
        cycleMs: t1 - t0,
        constructMs,
        constructNsPerEntity: (constructMs * 1e6) / spawns,
        heapDelta: after - before,
        poolSize: pool?.size ?? 0
    };
}

console.log(`\nEntity churn benchmark — ${N} entities × ${TICKS} ticks = ${spawns.toLocaleString("en-US")} spawns`);
console.log(`(each entity = ${INSTANCES_PER_ENTITY} Schema instances; gc=${gc ? "on" : "off"})\n`);

const noPool = runChurn(false);
const pooled = runChurn(true);

const row = (label: string, r: ReturnType<typeof runChurn>) => {
    console.log(`${label.padEnd(14)} construct: ${r.constructMs.toFixed(1).padStart(8)} ms  ` +
        `${r.constructNsPerEntity.toFixed(0).padStart(6)} ns/entity   ` +
        `full cycle: ${r.cycleMs.toFixed(1).padStart(8)} ms   ` +
        `heapΔ: ${(r.heapDelta / 1024 / 1024).toFixed(1).padStart(7)} MB`);
};

row("new Entity()", noPool);
row("pool.acquire()", pooled);
console.log(`\nConstruction speedup: ${(noPool.constructNsPerEntity / pooled.constructNsPerEntity).toFixed(1)}x faster` +
    `   (full-cycle: ${(noPool.cycleMs / pooled.cycleMs).toFixed(2)}x — diluted by identical encode/decode cost)`);
console.log(`Pool retained ${pooled.poolSize} instances after the run.\n`);
