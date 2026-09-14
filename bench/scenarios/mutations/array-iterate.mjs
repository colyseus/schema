// Walking an ArraySchema<Schema> on the encoder side, the way user code
// does. V8 runs an `Array.prototype` builtin on an Array subclass (6.x) or
// a Proxy (5.x) through its generic per-property path; ArraySchema 6.x
// overrides the common builtins and the iterators with index loops over the
// raw target. The `index` variant reads every element through the Proxy —
// the one access pattern that cannot be redirected.
import { setBufferSize } from "../../lib/fixtures.mjs";

const SIZE = 2000;

export default {
    name: "mutations/array-iterate",
    unit: "µs/op",
    reps: 7,
    iterations: 3000,
    valueScale: 1000, // ms/op -> µs/op
    variants: [
        { name: "forEach", op: "forEach" },
        { name: "for-of", op: "for-of" },
        { name: "index", op: "index" },
        { name: "map", op: "map" },
        { name: "filter", op: "filter" },
        { name: "indexOf-last", op: "indexOf" },
        { name: "shift-push", op: "shift-push" },
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
        for (let i = 0; i < SIZE; i++) state.items.push(mk(i));
        encoder.encode();
        encoder.discardChanges();
        return { items: state.items, encoder, mk, op: variant.op };
    },
    run(ctx, i) {
        const { items, op } = ctx;
        let sum = 0;
        switch (op) {
            case "forEach": items.forEach((it) => { sum += it.value; }); break;
            case "for-of": for (const it of items) sum += it.value; break;
            case "index": for (let k = 0, n = items.length; k < n; k++) sum += items[k].value; break;
            case "map": sum = items.map((it) => it.value).length; break;
            case "filter": sum = items.filter((it) => (it.value & 1) === 0).length; break;
            case "indexOf": sum = items.indexOf(items[SIZE - 1]); break;
            case "shift-push": {
                // no encode: the mutation itself, not the wire
                items.shift();
                items.push(ctx.mk(SIZE + i));
                ctx.encoder.discardChanges();
                sum = items.length;
                break;
            }
        }
        return sum >= 0 ? undefined : -1; // sink guard, no bytes metric
    },
};
