// Small patch: the fixed per-tick cost when almost nothing changed in a room
// that holds 5000 entities.
//   root-field          — state.tick++ only, no views
//   one-entity / five-entities — x,y of 1 / 5 entities, no views
//   root-field-50views  — state.tick++ with 50 AOI views attached (nothing filtered is dirty)
//   idle-50views        — no change at all: the `hasChanges === false` path with 50 views
//   dec-one-entity      — decoding the one-entity frame
import { codecOf, withCodecs, defineArena, buildArena, serverTick } from "../../lib/realworld.mjs";

const N = 5000;
const FRAMES = 64;

export default {
    name: "realworld/small-patch",
    unit: "µs/tick",
    valueScale: 1000,
    gate: true,
    budget: { "root-field": 0.4 }, // ~2x M4-ABCD median (0.192 µs/tick, round-2 re-baseline)
    reps: 7,
    variants: withCodecs([
        { name: "root-field", mode: "root", clients: 0, iterations: 20000 },
        { name: "one-entity", mode: "entities", count: 1, clients: 0, iterations: 20000 },
        { name: "five-entities", mode: "entities", count: 5, clients: 0, iterations: 20000 },
        { name: "root-field-50views", mode: "root", clients: 50, iterations: 5000 },
        { name: "idle-50views", mode: "idle", clients: 50, iterations: 5000 },
        { name: "dec-one-entity", mode: "dec", clients: 0, iterations: 20000 },
    ]),
    setup(lib, variant) {
        const codec = codecOf(lib, variant);
        const shapes = defineArena(lib, { viewEntities: variant.clients > 0 });
        const arena = buildArena(lib, codec, shapes, { n: N, clients: variant.clients });
        serverTick(codec, arena.encoder, arena.views);
        const ctx = { codec, ...arena, mode: variant.mode, count: variant.count ?? 0 };
        if (variant.mode === "dec") {
            const decoder = new codec.Decoder(new shapes.State());
            decoder.decode(arena.encoder.encodeAll());
            const frames = [];
            for (let f = 0; f < FRAMES; f++) {
                const e = arena.entities[f % N];
                e.x += 1; e.y += 1;
                frames.push(arena.encoder.encode().slice());
                arena.encoder.discardChanges();
            }
            ctx.decoder = decoder;
            ctx.frames = frames;
        }
        return ctx;
    },
    run(ctx, i) {
        const { codec, encoder, views, state, entities, mode } = ctx;
        if (mode === "dec") {
            const frame = ctx.frames[i % FRAMES];
            ctx.decoder.decode(frame);
            return frame.byteLength;
        }
        if (mode === "root") state.tick = i;
        else if (mode === "entities") {
            for (let k = 0; k < ctx.count; k++) {
                const e = entities[(i * ctx.count + k) % N];
                e.x += 1; e.y += 1;
            }
        }
        return serverTick(codec, encoder, views);
    },
};
