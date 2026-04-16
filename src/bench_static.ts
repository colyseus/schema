/**
 * Benchmark: per-tick encode cost with vs without `.static()` on fields
 * that are mutated every tick but semantically configure-once.
 *
 * Scenario: 1000 entities with 4 "config" fields + 2 "dynamic" fields.
 * Both variants mutate all 6 fields on all entities every tick. The
 * `.static()` variant skips change-tracking for the 4 config fields,
 * so per-tick encode emits and transmits only the 2 dynamic ones.
 *
 * Measures (per 1000 ticks of 1000 entities × 6 mutations):
 *   - encode() wall time
 *   - encoded tick patch size (bytes)
 */

import { Encoder, Schema, type, schema, t, MapSchema } from "./index";

const NUM_ENTITIES = 1000;
const NUM_TICKS = 1000;

// ──────────────────────────────────────────────────────────────────────────
// Variant A: all fields tracked (no .static())
// ──────────────────────────────────────────────────────────────────────────
const EntityA = schema({
    maxHp: t.uint16(),
    team: t.uint8(),
    mapId: t.uint8(),
    spawnIndex: t.uint16(),
    hp: t.uint16(),
    x: t.float32(),
}, "EntityA");
const StateA = schema({
    entities: t.map(EntityA),
}, "StateA");

// ──────────────────────────────────────────────────────────────────────────
// Variant B: 4 fields marked `.static()` (sync-once, tick-skip)
// ──────────────────────────────────────────────────────────────────────────
const EntityB = schema({
    maxHp: t.uint16().static(),
    team: t.uint8().static(),
    mapId: t.uint8().static(),
    spawnIndex: t.uint16().static(),
    hp: t.uint16(),
    x: t.float32(),
}, "EntityB");
const StateB = schema({
    entities: t.map(EntityB),
}, "StateB");

function run<T extends Schema, E extends Schema>(
    label: string,
    StateCtor: new () => T,
    EntityCtor: new () => E,
) {
    const state = new StateCtor();
    const entitiesMap = (state as any).entities as MapSchema<E>;

    for (let i = 0; i < NUM_ENTITIES; i++) {
        const e = new EntityCtor();
        (e as any).maxHp = 100;
        (e as any).team = i % 4;
        (e as any).mapId = 1;
        (e as any).spawnIndex = i;
        (e as any).hp = 100;
        (e as any).x = 0;
        entitiesMap.set(`e${i}`, e);
    }

    const encoder = new Encoder(state);

    // Prime: initial encode + discard so tick timings measure steady-state.
    encoder.encode();
    encoder.discardChanges();

    let totalBytes = 0;
    const start = performance.now();
    for (let tick = 0; tick < NUM_TICKS; tick++) {
        for (let i = 0; i < NUM_ENTITIES; i++) {
            const e = entitiesMap.get(`e${i}`);
            // Mutate all 6 fields. The `.static()` variant will silently
            // drop the first 4 at tracking time.
            (e as any).maxHp = 100 + (tick & 15);
            (e as any).team = i % 4;
            (e as any).mapId = 1;
            (e as any).spawnIndex = i;
            (e as any).hp = 100 - (tick & 31);
            (e as any).x = tick * 0.1;
        }
        const bytes = encoder.encode();
        totalBytes += bytes.length;
        encoder.discardChanges();
    }
    const elapsed = performance.now() - start;

    console.log(
        `${label.padEnd(28)} ${elapsed.toFixed(1).padStart(7)} ms total, ` +
        `${(elapsed / NUM_TICKS).toFixed(3)} ms/tick, ` +
        `${(totalBytes / NUM_TICKS).toFixed(0)} bytes/tick`
    );
}

// Warm up JIT with a short run on each variant before measuring.
run("warmup-A", StateA as any, EntityA as any);
run("warmup-B", StateB as any, EntityB as any);

console.log();
console.log(`--- ${NUM_ENTITIES} entities × ${NUM_TICKS} ticks × 6 mutations ---`);
run("without .static()", StateA as any, EntityA as any);
run("with .static() on 4 of 6", StateB as any, EntityB as any);
