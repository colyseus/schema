// Area-of-interest room: N moving entities in a `@view()` map, C stationary
// clients each seeing the 3×3 grid cells around them (~9 % of the world).
// Per tick: every entity moves (x += vx, y += vy, rotation), entities crossing
// a cell boundary are removed from / added to the affected views, every 10th
// tick 5 % lose hp, the root `tick` advances and 5 players score — then the
// exact server sequence (shared encode + one encodeView per client).
import { codecOf, withCodecs, defineArena, buildArena, moveEntities, serverTick } from "../../lib/realworld.mjs";

export function aoiSetup(lib, variant) {
    const codec = codecOf(lib, variant);
    const shapes = defineArena(lib, { numType: variant.numType, nested: variant.nested, keyType: variant.keyType });
    if (variant.bufferMb) lib.Encoder.BUFFER_SIZE = variant.bufferMb * 1024 * 1024;
    const arena = buildArena(lib, codec, shapes, { n: variant.n, clients: variant.clients });
    serverTick(codec, arena.encoder, arena.views); // flush construction
    const players = [];
    arena.state.players.forEach((p) => players.push(p));
    return { codec, shapes, ...arena, players, moveCount: variant.move ?? variant.n, crossings: 0 };
}

export function aoiRun(ctx, i) {
    const { codec, state, encoder, views, entities, players, moveCount } = ctx;
    ctx.crossings += moveEntities(ctx, i * moveCount, moveCount);
    if (i % 10 === 0) {
        const n = entities.length;
        for (let k = 0; k < n; k += 20) {
            const e = entities[(i + k) % n];
            e.hp = e.hp > 1 ? e.hp - 1 : 100;
        }
    }
    state.tick = i;
    for (let k = 0; k < 5; k++) players[(i + k) % players.length].score++;
    return serverTick(codec, encoder, views);
}

export function aoiTeardown(ctx) {
    if (ctx.views.length > 0 && ctx.crossings === 0) throw new Error("AOI never churned (no cell crossings)");
}

export default {
    name: "realworld/entities-aoi",
    unit: "ms/tick",
    gate: true,
    budget: { "n2000-c50": 2.0 }, // ~2x M4-ABCD median (0.987 ms/tick, round-2 re-baseline)
    reps: 7,
    variants: withCodecs([
        { name: "n500-c10", n: 500, clients: 10, iterations: 200 },
        { name: "n2000-c50", n: 2000, clients: 50, iterations: 100 },
        { name: "n2000-c50-nested", n: 2000, clients: 50, nested: true, iterations: 100 },
        { name: "n2000-c50-typed", n: 2000, clients: 50, numType: "typed", iterations: 100 },
        { name: "n2000-c50-numkeys", n: 2000, clients: 50, keyType: "number", iterations: 100 },
    ]),
    setup: aoiSetup,
    run: aoiRun,
    teardown: aoiTeardown,
};
