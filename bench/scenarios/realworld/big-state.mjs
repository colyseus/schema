// Big state, no views: 10k / 20k entities + 100 players + 2000 tiles + config.
//   encode-*    — encodeAll() of the whole state (what a joining client receives)
//   decode-*    — a fresh Decoder consuming that snapshot (client join cost)
//   decode-10k-callbacks — same with the idiomatic onAdd(entities) → listen(x, y)
//   handshake   — Reflection.encode + Reflection.decode
import { codecOf, withCodecs, defineWorld, buildWorld, attachCallbacks } from "../../lib/realworld.mjs";

export default {
    name: "realworld/big-state",
    unit: "ms/op",
    reps: 5,
    warmup: 5,
    variants: withCodecs([
        { name: "encode-10k", n: 10000, mode: "encode", iterations: 40 },
        { name: "encode-20k", n: 20000, mode: "encode", iterations: 20 },
        { name: "decode-10k", n: 10000, mode: "decode", iterations: 40 },
        { name: "decode-20k", n: 20000, mode: "decode", iterations: 20 },
        { name: "decode-10k-callbacks", n: 10000, mode: "decode", callbacks: true, iterations: 40 },
        { name: "handshake", n: 10000, mode: "handshake", iterations: 200 },
    ]),
    setup(lib, variant) {
        const codec = codecOf(lib, variant);
        const shapes = defineWorld(lib);
        lib.Encoder.BUFFER_SIZE = 16 * 1024 * 1024;
        const { state, encoder } = buildWorld(lib, codec, shapes, { n: variant.n });
        encoder.discardChanges();
        const snapshot = encoder.encodeAll().slice();
        const handshake = codec.Reflection.encode(encoder);
        return { lib, codec, shapes, state, encoder, snapshot, handshake, mode: variant.mode, callbacks: variant.callbacks, counters: null };
    },
    run(ctx) {
        if (ctx.mode === "encode") return ctx.encoder.encodeAll().byteLength;
        if (ctx.mode === "handshake") {
            const decoder = ctx.codec.Reflection.decode(ctx.codec.Reflection.encode(ctx.encoder));
            return ctx.handshake.byteLength + (decoder.state ? 0 : 1);
        }
        const decoder = new ctx.codec.Decoder(new ctx.shapes.State());
        if (ctx.callbacks) ctx.counters = attachCallbacks(ctx.lib, decoder, { entities: ["x", "y"] });
        decoder.decode(ctx.snapshot);
        return ctx.snapshot.byteLength;
    },
    teardown(ctx) {
        if (ctx.callbacks && (!ctx.counters || ctx.counters.onAdd === 0)) throw new Error("callbacks never fired");
    },
};
