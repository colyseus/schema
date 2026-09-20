// RPG room: 200 heroes × 20 inventory items. Per tick every hero moves, 10
// take damage / spend mana, 5 gain an item, 5 lose one, 2 get a fresh Stats
// instance (ref replace → decoder GC), 1 levels up.
//   enc       — encode bytes/time
//   dec       — one full client decoding pre-generated frames (consumed once)
//   callbacks — same with onAdd(heroes)→listen(hp, level) + per-hero inventory onAdd/onRemove
import { codecOf, withCodecs, defineRpg, buildRpg, rpgTick, makeFullClient } from "../../lib/realworld.mjs";

export default {
    name: "realworld/inventory-rpg",
    unit: "ms/tick",
    reps: 7,
    iterations: 500,
    variants: withCodecs([
        { name: "enc", mode: "enc" },
        { name: "dec", mode: "dec" },
        { name: "callbacks", mode: "dec", callbacks: true },
    ]),
    setup(lib, variant, plan) {
        const codec = codecOf(lib, variant);
        const shapes = defineRpg(lib);
        const rpg = buildRpg(lib, codec, shapes, { heroes: 200, items: 20 });
        const { encoder } = rpg;
        encoder.discardChanges();
        const ctx = { codec, shapes, ...rpg, mode: variant.mode, counters: null };
        if (variant.mode === "dec") {
            const decoder = makeFullClient(lib, codec, encoder);
            if (variant.callbacks) {
                const $ = lib.Callbacks.get(decoder);
                const counters = { onAdd: 0, onRemove: 0, listen: 0, itemAdd: 0, itemRemove: 0 };
                $.onAdd("heroes", (hero) => {
                    counters.onAdd++;
                    $.listen(hero, "hp", () => { counters.listen++; });
                    $.listen(hero, "level", () => { counters.listen++; });
                    $.onAdd(hero, "inventory", () => { counters.itemAdd++; });
                    $.onRemove(hero, "inventory", () => { counters.itemRemove++; });
                });
                $.onRemove("heroes", () => { counters.onRemove++; });
                ctx.counters = counters;
            }
            const frames = new Array(plan.totalRuns);
            for (let i = 0; i < plan.totalRuns; i++) {
                rpgTick(ctx, i);
                frames[i] = encoder.encode().slice();
                encoder.discardChanges();
            }
            ctx.decoder = decoder;
            ctx.frames = frames;
        }
        return ctx;
    },
    run(ctx, i) {
        if (ctx.mode === "dec") {
            const frame = ctx.frames[i];
            ctx.decoder.decode(frame);
            return frame.byteLength;
        }
        rpgTick(ctx, i);
        const bytes = ctx.encoder.encode().byteLength;
        ctx.encoder.discardChanges();
        return bytes;
    },
    teardown(ctx) {
        const c = ctx.counters;
        if (c && (c.onAdd === 0 || c.listen === 0 || c.itemAdd === 0 || c.itemRemove === 0)) {
            throw new Error(`callbacks never fired: ${JSON.stringify(c)}`);
        }
    },
};
