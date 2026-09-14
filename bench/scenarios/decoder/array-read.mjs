// Reading a decoded ArraySchema<Schema> the way client code does every
// frame: index loop, for…of, spread, forEach / map / filter, indexOf. This
// is the decoder-side counterpart of mutations/array-iterate — the usage
// survey (bench/array-impl-comparison.md) puts index reads and iteration on
// the client far ahead of every mutation.
import { setBufferSize, codecOf } from "../../lib/fixtures.mjs";

const SIZE = 2000;

export default {
    name: "decoder/array-read",
    unit: "µs/op",
    reps: 7,
    iterations: 3000,
    valueScale: 1000, // ms/op -> µs/op
    variants: [
        { name: "index", op: "index" },
        { name: "for-of", op: "for-of" },
        { name: "spread", op: "spread" },
        { name: "forEach", op: "forEach" },
        { name: "map", op: "map" },
        { name: "filter", op: "filter" },
        { name: "indexOf-last", op: "indexOf" },
        { name: "length+at", op: "at" },
    ],
    setup(lib, variant) {
        setBufferSize(lib);
        const codec = codecOf(lib);
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
        const encoder = new codec.Encoder(state);
        for (let i = 0; i < SIZE; i++) { const it = new Item(); it.value = i; state.items.push(it); }
        const bootstrap = encoder.encodeAll().slice();
        encoder.discardChanges();

        const client = new ArrayState();
        const decoder = new codec.Decoder(client);
        decoder.decode(bootstrap);
        if (client.items.length !== SIZE) throw new Error("bootstrap failed: " + client.items.length);
        return { items: client.items, op: variant.op };
    },
    run(ctx) {
        const { items, op } = ctx;
        let sum = 0;
        switch (op) {
            case "index": for (let k = 0, n = items.length; k < n; k++) sum += items[k].value; break;
            case "for-of": for (const it of items) sum += it.value; break;
            case "spread": sum = [...items].length; break;
            case "forEach": items.forEach((it) => { sum += it.value; }); break;
            case "map": sum = items.map((it) => it.value).length; break;
            case "filter": sum = items.filter((it) => (it.value & 1) === 0).length; break;
            case "indexOf": sum = items.indexOf(items[SIZE - 1]); break;
            case "at": for (let k = 0, n = items.length; k < n; k += 7) sum += items.at(k).value; break;
        }
        return sum >= 0 ? undefined : -1;
    },
};
