/**
 * bench_stream.ts — RTS-style ECS workload over StreamSchema.
 *
 * Simulates a room with many units, each built from several polymorphic
 * components (Hp, Team, Position, Velocity). Exercises:
 *   - Encode throughput of a large initial spawn spread across ticks
 *     (priority-batched per-view vs broadcast).
 *   - Steady-state per-tick mutation cost (hp damage + position move).
 *   - Memory footprint.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json --expose-gc src/bench_stream.ts
 */
import {
    Encoder,
    Schema,
    type,
    ArraySchema,
    StreamSchema,
    StateView,
} from "./index";

// Pre-size the shared buffer so the steady-state loops don't print
// overflow-warning noise mid-measurement.
Encoder.BUFFER_SIZE = 256 * 1024;

// ─── Schema ───────────────────────────────────────────────────────────

class Vec3 extends Schema {
    @type("number") x: number = 0;
    @type("number") y: number = 0;
    @type("number") z: number = 0;
}

class Component extends Schema {
    @type("string") kind: string = "";
}

class Hp extends Component {
    @type("uint16") current: number = 100;
    @type("uint16") max: number = 100;
}

class Team extends Component {
    @type("uint8") teamId: number = 0;
    @type("uint32") color: number = 0xffffff;
}

class Position extends Component {
    @type(Vec3) value: Vec3 = new Vec3();
}

class Velocity extends Component {
    @type(Vec3) value: Vec3 = new Vec3();
}

class Unit extends Schema {
    @type("string") name: string = "";
    @type([Component]) components = new ArraySchema<Component>();
}

class State extends Schema {
    @type({ stream: Unit }) units = new StreamSchema<Unit>();
}

// ─── Helpers ──────────────────────────────────────────────────────────

function mkUnit(i: number): Unit {
    const u = new Unit().assign({ name: `U${i}` });
    const hp = new Hp().assign({ kind: "hp", current: 100, max: 100 });
    const team = new Team().assign({ kind: "team", teamId: i % 2, color: 0xff0000 });
    const pos = new Position().assign({ kind: "position" });
    pos.value.assign({ x: i, y: 0, z: i * 2 });
    const vel = new Velocity().assign({ kind: "velocity" });
    vel.value.assign({ x: 1, y: 0, z: 1 });
    u.components.push(hp);
    u.components.push(team);
    u.components.push(pos);
    u.components.push(vel);
    return u;
}

function ms(fn: () => void): number {
    const t = performance.now();
    fn();
    return performance.now() - t;
}

function sum(arr: number[]): number {
    let s = 0;
    for (const v of arr) s += v;
    return s;
}

// ─── 1. Memory footprint ──────────────────────────────────────────────

const UNIT_COUNT = 1000;

globalThis.gc?.();
const heapBefore = process.memoryUsage().heapUsed;

const state = new State();
const encoder = new Encoder(state);

for (let i = 0; i < UNIT_COUNT; i++) {
    state.units.add(mkUnit(i));
}

globalThis.gc?.();
const heapAfter = process.memoryUsage().heapUsed;
console.log(`Heap for ${UNIT_COUNT} units × 4 components: ${((heapAfter - heapBefore) / 1024 / 1024).toFixed(2)} MB`);

// ─── 2. Broadcast-mode encoding (no views) ────────────────────────────
// maxPerTick drains units in batches. Measure bytes + time per tick
// until the backlog is fully drained.

{
    const s = new State();
    s.units.maxPerTick = 50;
    const enc = new Encoder(s);

    // Spawn all units in one "tick" (worst case for backlog).
    for (let i = 0; i < UNIT_COUNT; i++) {
        s.units.add(mkUnit(i));
    }

    // Bootstrap full state snapshot.
    enc.encodeAll();
    enc.discardChanges();

    const tickTimes: number[] = [];
    const tickBytes: number[] = [];
    let tick = 0;
    while (
        ((s.units as any)._stream?.broadcastPending.size ?? 0) > 0 ||
        ((s.units as any)._stream?.broadcastDeletes.size ?? 0) > 0
    ) {
        tick++;
        const t = performance.now();
        const bytes = enc.encode();
        tickTimes.push(performance.now() - t);
        tickBytes.push(bytes.length);
        enc.discardChanges();
        if (tick > 1000) throw new Error("drain did not converge");
    }
    console.log(
        `Broadcast drain: ${tick} ticks @ maxPerTick=50, total=${sum(tickBytes)} bytes, ` +
        `avg=${(sum(tickTimes) / tick).toFixed(3)}ms/tick`,
    );
}

// ─── 3. View-mode encoding (1 client) ─────────────────────────────────
// Same workload but with a StateView. Exercises the priority pass +
// per-view pending state.

{
    const s = new State();
    s.units.maxPerTick = 50;
    const enc = new Encoder(s);

    // Instance-level priority override (same sort path exercised).
    s.units.priority = (_view: any, el: Unit) => {
        const pos = el.components[2] as Position;
        return -(pos?.value?.x ?? 0);
    };

    // Create view BEFORE adding units so stream.add doesn't seed
    // broadcast pending (view mode = no auto-seed, explicit subscribe).
    const view = new StateView();
    view.add(s);

    for (let i = 0; i < UNIT_COUNT; i++) {
        const u = mkUnit(i);
        s.units.add(u);
        view.add(u);
    }

    // Bootstrap.
    const bootIt = { offset: 0 };
    enc.encodeAll(bootIt);
    const bootShared = bootIt.offset;
    enc.encodeAllView(view, bootShared, bootIt);
    enc.discardChanges();

    const tickTimes: number[] = [];
    const tickBytes: number[] = [];
    let tick = 0;
    while (true) {
        const pending = (s.units as any)._stream?.pendingByView.get(view.id);
        if (!pending || pending.size === 0) break;
        tick++;
        const t = performance.now();
        const it = { offset: 0 };
        enc.encode(it);
        const sharedOffset = it.offset;
        const bytes = enc.encodeView(view, sharedOffset, it);
        tickTimes.push(performance.now() - t);
        tickBytes.push(bytes.length);
        enc.discardChanges();
        if (tick > 1000) throw new Error("drain did not converge");
    }
    console.log(
        `View drain: ${tick} ticks @ maxPerTick=50 w/ priority sort, total=${sum(tickBytes)} bytes, ` +
        `avg=${(sum(tickTimes) / tick).toFixed(3)}ms/tick`,
    );
}

// ─── 4. Steady-state mutations ────────────────────────────────────────
// After the backlog is drained, simulate 60Hz gameplay: every unit's
// hp.current and position.value.x mutate each tick.

{
    const s = new State();
    s.units.maxPerTick = Number.MAX_SAFE_INTEGER; // drain everything immediately
    const enc = new Encoder(s);

    const units: Unit[] = [];
    for (let i = 0; i < UNIT_COUNT; i++) {
        const u = mkUnit(i);
        units.push(u);
        s.units.add(u);
    }

    // Bootstrap — drain the whole backlog in one tick.
    enc.encodeAll();
    enc.encode();
    enc.discardChanges();

    const iterations = 200;
    const mutateAndEncode = ms(() => {
        for (let it = 0; it < iterations; it++) {
            for (const u of units) {
                const hp = u.components[0] as Hp;
                const pos = u.components[2] as Position;
                hp.current = Math.max(0, hp.current - 1);
                pos.value.x++;
            }
            enc.encode();
            enc.discardChanges();
        }
    });
    console.log(
        `Steady-state mutations (${iterations} ticks × ${UNIT_COUNT} units × 2 fields): ` +
        `${mutateAndEncode.toFixed(1)}ms total, ${(mutateAndEncode / iterations).toFixed(3)}ms/tick`,
    );
}

// ─── 5. View-mode steady state (1 client w/ per-view priority) ────────

{
    const s = new State();
    s.units.maxPerTick = Number.MAX_SAFE_INTEGER;
    const enc = new Encoder(s);

    // View must exist before units so stream.add doesn't seed broadcast.
    const view = new StateView();
    view.add(s);

    const units: Unit[] = [];
    for (let i = 0; i < UNIT_COUNT; i++) {
        const u = mkUnit(i);
        units.push(u);
        s.units.add(u);
        view.add(u);
    }

    const bootIt = { offset: 0 };
    enc.encodeAll(bootIt);
    const bootShared = bootIt.offset;
    enc.encodeAllView(view, bootShared, bootIt);
    // Drain pending.
    const drainIt = { offset: 0 };
    enc.encode(drainIt);
    enc.encodeView(view, drainIt.offset, drainIt);
    enc.discardChanges();

    const iterations = 200;
    const mutateAndEncode = ms(() => {
        for (let it = 0; it < iterations; it++) {
            for (const u of units) {
                const hp = u.components[0] as Hp;
                const pos = u.components[2] as Position;
                hp.current = Math.max(0, hp.current - 1);
                pos.value.x++;
            }
            const tickIt = { offset: 0 };
            enc.encode(tickIt);
            enc.encodeView(view, tickIt.offset, tickIt);
            enc.discardChanges();
        }
    });
    console.log(
        `View steady-state (${iterations} ticks × ${UNIT_COUNT} units × 2 fields, 1 client): ` +
        `${mutateAndEncode.toFixed(1)}ms total, ${(mutateAndEncode / iterations).toFixed(3)}ms/tick`,
    );
}
