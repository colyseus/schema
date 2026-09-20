// Lobby with chat: 100 players (ready/ping toggles) and a 50-message ring
// buffer (push + shift per tick), topic changes every 100 ticks.
//   enc       — encode bytes/time
//   dec       — one full client decoding pre-generated frames (ADD/DELETE → consumed once)
//   callbacks — same, with onAdd/onRemove(messages) and listen(player.ready/ping)
import { codecOf, withCodecs, defineLobby, buildLobby, makeMessage, makeFullClient, attachCallbacks } from "../../lib/realworld.mjs";

function lobbyTick(ctx, i) {
    const { state, players, rng, shapes } = ctx;
    state.messages.push(makeMessage(shapes, rng, i));
    if (state.messages.length > ctx.history) state.messages.shift();
    for (let k = 0; k < 3; k++) {
        const p = players[(i * 3 + k) % players.length];
        p.ready = !p.ready;
    }
    for (let k = 0; k < 20; k++) {
        const p = players[(i * 20 + k) % players.length];
        p.ping = 20 + ((i + k) % 200);
    }
    if (i % 100 === 0) state.topic = `topic-${i / 100}`;
}

export default {
    name: "realworld/lobby-chat",
    unit: "ms/tick",
    reps: 7,
    iterations: 1000,
    variants: withCodecs([
        { name: "enc", mode: "enc" },
        { name: "dec", mode: "dec" },
        { name: "callbacks", mode: "dec", callbacks: true },
    ]),
    setup(lib, variant, plan) {
        const codec = codecOf(lib, variant);
        const shapes = defineLobby(lib);
        const lobby = buildLobby(lib, codec, shapes, { players: 100, history: 50 });
        const { encoder } = lobby;
        encoder.discardChanges();
        const ctx = { codec, shapes, ...lobby, mode: variant.mode, counters: null };
        if (variant.mode === "dec") {
            const decoder = makeFullClient(lib, codec, encoder);
            if (variant.callbacks) ctx.counters = attachCallbacks(lib, decoder, { messages: ["text"], players: ["ready", "ping"] });
            const frames = new Array(plan.totalRuns);
            for (let i = 0; i < plan.totalRuns; i++) {
                lobbyTick(ctx, i);
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
        lobbyTick(ctx, i);
        const bytes = ctx.encoder.encode().byteLength;
        ctx.encoder.discardChanges();
        return bytes;
    },
    teardown(ctx) {
        if (ctx.counters && (ctx.counters.onAdd === 0 || ctx.counters.onRemove === 0 || ctx.counters.listen === 0)) {
            throw new Error(`callbacks never fired: ${JSON.stringify(ctx.counters)}`);
        }
    },
};
