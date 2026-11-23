import * as assert from "assert";
import * as v8 from "v8";
import * as vm from "vm";
import { MapSchema, Schema, type, ArraySchema, defineTypes, Reflection, Encoder, $changes, schema, t } from "../src";

import { State, Player, getCallbacks, assertDeepStrictEqualEncodeAll, createInstanceFromReflection } from "./Schema";

describe("Encoder", () => {
    const bufferSize = Encoder.BUFFER_SIZE;

    before(() => Encoder.BUFFER_SIZE = 16);
    after(() => Encoder.BUFFER_SIZE = bufferSize);

    it("releases encoder state after attaching a child collection", async () => {
        const Item = schema({ name: t.string() });
        const RoomState = schema({ items: t.array(Item) });
        const refs = (() => {
            const state = new RoomState();
            const encoder = new Encoder(state);
            state.items = new ArraySchema(new Item());
            return [new WeakRef(state), new WeakRef(encoder.root)];
        })();

        v8.setFlagsFromString("--expose-gc");
        const gc: () => void = vm.runInNewContext("gc");
        await new Promise<void>((resolve) => setImmediate(resolve));
        gc();
        gc();
        assert.ok(refs.every((ref) => ref.deref() === undefined));
    });

    it("should resize buffer", () => {
        const state = new State();

        state.mapOfPlayers = new MapSchema<Player>();
        for (let i=0;i<5000;i++) {
            state.mapOfPlayers.set("player" + i, new Player().assign({
                name: "Player " + i,
                x: 50 * i,
                y: 50 * i,
            }));
        }

        const decodedState = createInstanceFromReflection(state);
        decodedState.decode(state.encode());
    });

});
