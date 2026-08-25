// ArraySchema push/pop + encode per tick (bench_bloat M9).
import { setBufferSize } from "../../lib/fixtures.mjs";

export default {
    name: "encoder/array-churn",
    unit: "ms/tick",
    iterations: 5000,
    reps: 7,
    setup(lib) {
        setBufferSize(lib);
        class ArrayState extends lib.Schema {
            constructor() {
                super(...arguments);
                this.items = new lib.ArraySchema();
            }
        }
        lib.type(["number"])(ArrayState.prototype, "items", undefined);

        const state = new ArrayState();
        const encoder = new lib.Encoder(state);
        for (let i = 0; i < 100; i++) state.items.push(i);
        encoder.encode();
        encoder.discardChanges();
        return { state, encoder };
    },
    run(ctx, i) {
        ctx.state.items.push(100 + i);
        ctx.state.items.pop();
        const bytes = ctx.encoder.encode().byteLength;
        ctx.encoder.discardChanges();
        return bytes;
    },
};
