// Large patch: 100 % of 5000 entities change x, y, vx, vy every tick
// (fractional physics step), no views.
//   enc-5k / -typed / -nested / -quantized — encode() bytes and time
//   dec-5k / -typed                         — decode of pre-generated frames (REPLACE only → replay-safe)
// `enc-5k-quantized` needs `t.quantized` (6.0); on an older build the variant
// reports 0 and says so on stderr.
import { codecOf, withCodecs, defineArena, buildArena, hasQuantized, WORLD_SIZE } from "../../lib/realworld.mjs";

const N = 5000;
const FRAMES = 64;

function physicsStep(ctx) {
    const { entities, acc } = ctx;
    for (let i = 0; i < entities.length; i++) {
        const e = entities[i];
        let vx = e.vx + 0.0013, vy = e.vy - 0.0007;
        let x = acc.getX(e) + vx, y = acc.getY(e) + vy;
        if (x < 0) { x = -x; vx = -vx; } else if (x > WORLD_SIZE) { x = 2 * WORLD_SIZE - x; vx = -vx; }
        if (y < 0) { y = -y; vy = -vy; } else if (y > WORLD_SIZE) { y = 2 * WORLD_SIZE - y; vy = -vy; }
        acc.setX(e, x); acc.setY(e, y);
        e.vx = vx; e.vy = vy;
    }
}

export default {
    name: "realworld/large-patch",
    unit: "ms/tick",
    gate: true,
    budget: { "enc-5k": 1.6 }, // ~2x M4-ABCD median (0.781 ms/tick, round-2 re-baseline)
    reps: 7,
    iterations: 150,
    variants: withCodecs([
        { name: "enc-5k", mode: "enc" },
        { name: "enc-5k-typed", mode: "enc", numType: "typed" },
        { name: "enc-5k-nested", mode: "enc", nested: true },
        { name: "enc-5k-quantized", mode: "enc", numType: "quantized" },
        { name: "dec-5k", mode: "dec" },
        { name: "dec-5k-typed", mode: "dec", numType: "typed" },
    ]),
    setup(lib, variant) {
        const codec = codecOf(lib, variant);
        if (variant.numType === "quantized" && !hasQuantized(lib)) {
            console.error(`[skip] ${variant.name}: build has no t.quantized`);
            return { skip: true };
        }
        const shapes = defineArena(lib, { numType: variant.numType, nested: variant.nested, viewEntities: false });
        const arena = buildArena(lib, codec, shapes, { n: N, clients: 0 });
        const { encoder } = arena;
        encoder.discardChanges();
        const ctx = { codec, ...arena, mode: variant.mode };
        if (variant.mode === "dec") {
            const decoder = new codec.Decoder(new shapes.State());
            decoder.decode(encoder.encodeAll());
            const frames = [];
            for (let f = 0; f < FRAMES; f++) {
                physicsStep(ctx);
                frames.push(encoder.encode().slice());
                encoder.discardChanges();
            }
            ctx.decoder = decoder;
            ctx.frames = frames;
        }
        return ctx;
    },
    run(ctx, i) {
        if (ctx.skip) return 0;
        if (ctx.mode === "dec") {
            const frame = ctx.frames[i % FRAMES];
            ctx.decoder.decode(frame);
            return frame.byteLength;
        }
        physicsStep(ctx);
        const bytes = ctx.encoder.encode().byteLength;
        ctx.encoder.discardChanges();
        return bytes;
    },
};
