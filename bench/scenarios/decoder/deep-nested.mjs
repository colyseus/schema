// Deep-shape steady decode: REPLACE-only frames over 50 fully-populated
// players (position + tagged fields + item prices). Replay-safe.
import { defineDeep, makeDeepPlayer } from "../../lib/fixtures.mjs";

export default {
    name: "decoder/deep-nested",
    unit: "ms/frame",
    iterations: 300,
    reps: 7,
    setup(lib) {
        const shapes = defineDeep(lib);
        const state = new shapes.State();
        const encoder = new lib.Encoder(state);
        const players = [];
        for (let j = 0; j < 50; j++) {
            const p = makeDeepPlayer(shapes, j);
            state.players.set(`p${j}`, p);
            players.push(p);
        }
        const bootstrap = encoder.encodeAll().slice();
        encoder.discardChanges();

        const frames = [];
        for (let i = 0; i < 100; i++) {
            for (const p of players) {
                p.position.x++;
                p.position.y++;
                p.privateGold = i;
                p.items.get("item-0").price = i;
            }
            frames.push(encoder.encode().slice());
            encoder.discardChanges();
        }
        const decoder = new lib.Decoder(new shapes.State());
        decoder.decode(bootstrap);
        return { decoder, frames };
    },
    run(ctx, i) {
        ctx.decoder.decode(ctx.frames[i % ctx.frames.length]);
    },
};
