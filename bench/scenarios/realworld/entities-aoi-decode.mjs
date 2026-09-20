// Client side of the AOI room: one client's per-tick frames (shared + view
// slice, as the transport delivers them) pre-generated in setup and decoded
// once each (view churn = ADD/DELETE → not replay-safe).
import { codecOf, withCodecs, defineArena, buildArena, moveEntities, concatPair, makeViewClient, attachCallbacks } from "../../lib/realworld.mjs";

export default {
    name: "realworld/entities-aoi-decode",
    unit: "ms/frame",
    reps: 7,
    variants: withCodecs([
        { name: "n2000-c1", n: 2000, iterations: 200 },
        { name: "n2000-c1-callbacks", n: 2000, callbacks: true, iterations: 200 },
        { name: "n10000-c1", n: 10000, iterations: 100 },
    ]),
    setup(lib, variant, plan) {
        const codec = codecOf(lib, variant);
        const shapes = defineArena(lib);
        const arena = buildArena(lib, codec, shapes, { n: variant.n, clients: 1 });
        const { state, encoder, views, entities } = arena;
        const view = views[0];

        // client joins: handshake + full sync for its view
        const it0 = { offset: 0 };
        encoder.encode(it0); codec.encodeView(encoder, view, it0.offset, it0); encoder.discardChanges();
        const decoder = makeViewClient(lib, codec, encoder, view);
        const counters = variant.callbacks ? attachCallbacks(lib, decoder, { entities: ["x", "y"] }) : null;

        const players = [];
        state.players.forEach((p) => players.push(p));
        const frames = new Array(plan.totalRuns);
        for (let i = 0; i < plan.totalRuns; i++) {
            moveEntities(arena, 0, entities.length);
            if (i % 10 === 0) {
                for (let k = 0; k < entities.length; k += 20) {
                    const e = entities[(i + k) % entities.length];
                    e.hp = e.hp > 1 ? e.hp - 1 : 100;
                }
            }
            state.tick = i;
            players[0].score++;
            const it = { offset: 0 };
            encoder.encode(it);
            frames[i] = concatPair(codec.encodeView(encoder, view, it.offset, it));
            encoder.discardChanges();
        }
        return { decoder, frames, counters };
    },
    run(ctx, i) {
        const frame = ctx.frames[i];
        ctx.decoder.decode(frame);
        return frame.byteLength;
    },
    teardown(ctx) {
        if (ctx.counters && (ctx.counters.onAdd === 0 || ctx.counters.listen === 0)) throw new Error("callbacks never fired");
    },
};
