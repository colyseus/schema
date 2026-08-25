// ArraySchema<Schema> reindex cost, encoded every tick. Ref arrays are the
// case where a child's cached wire slot has to be refreshed when the array
// reindexes — number arrays skip that entirely, so mutations/array-ops
// cannot see it. Tail ops (push/pop) must stay free; head ops (shift,
// unshift, splice-at-0) pay one walk over the survivors.
import { setBufferSize } from "../../lib/fixtures.mjs";

export default {
    name: "mutations/array-refs",
    unit: "ms/tick",
    reps: 7,
    variants: [
        { name: "push-pop-100", op: "push-pop", size: 100, iterations: 20000 },
        { name: "push-pop-2000", op: "push-pop", size: 2000, iterations: 3000 },
        { name: "push-shift-100", op: "push-shift", size: 100, iterations: 20000 },
        { name: "push-shift-2000", op: "push-shift", size: 2000, iterations: 3000 },
        { name: "splice-head-500", op: "splice-head", size: 500, iterations: 5000 },
        { name: "unshift-pop-500", op: "unshift-pop", size: 500, iterations: 5000 },
    ],
    setup(lib, variant) {
        setBufferSize(lib);
        class Item extends lib.Schema {
            constructor() {
                super(...arguments);
                this.value = 0;
            }
        }
        lib.type("number")(Item.prototype, "value", undefined);

        class ArrayState extends lib.Schema {
            constructor() {
                super(...arguments);
                this.items = new lib.ArraySchema();
            }
        }
        lib.type([Item])(ArrayState.prototype, "items", undefined);

        const state = new ArrayState();
        const encoder = new lib.Encoder(state);
        const mk = (v) => { const it = new Item(); it.value = v; return it; };
        for (let i = 0; i < variant.size; i++) state.items.push(mk(i));
        encoder.encode();
        encoder.discardChanges();
        return { items: state.items, encoder, mk, op: variant.op };
    },
    run(ctx, i) {
        const { items, mk, op } = ctx;
        if (op === "push-pop") { items.push(mk(i)); items.pop(); }
        else if (op === "push-shift") { items.push(mk(i)); items.shift(); }
        else if (op === "splice-head") { items.splice(0, 1); items.push(mk(i)); }
        else { items.unshift(mk(i)); items.pop(); }
        const bytes = ctx.encoder.encode().byteLength;
        ctx.encoder.discardChanges();
        return bytes;
    },
};
