import * as assert from "assert";

import { State, Player, getEncoder, createInstanceFromReflection, getDecoder } from "./Schema";
import { MapSchema, dumpChanges, ArraySchema, Schema } from "../src";

describe("Utils Test", () => {

    describe("dumpChanges", () => {
        // it("Should not throw", () => {
        //     const state = new State();
        // });

        it("MapSchema", () => {
            const state = new State();
            getEncoder(state);// initialize encoder

            state.mapOfPlayers = new MapSchema<Player>();

            dumpChanges(state);

            state.mapOfPlayers.set('one', new Player("One", 1, 1));

            console.log(Schema.debugRefIds(state));

            let dump: any = dumpChanges(state);
            assert.strictEqual(
                JSON.stringify(dump),
                '{"ops":{"ADD":5},"refs":["refId#0","refId#1","refId#2"]}'
            );

            // discard changes
            state.encode();

            state.mapOfPlayers.delete('one');
            dump = dumpChanges(state);

            assert.strictEqual(
                JSON.stringify(dump),
                '{"ops":{"DELETE":1},"refs":["refId#1"]}'
            );
        });

        it("ArraySchema", () => {
            const state = new State();
            getEncoder(state);// initialize encoder

            state.arrayOfPlayers = new ArraySchema<Player>();
            state.arrayOfPlayers.push(new Player("One", 1, 1));
            state.arrayOfPlayers.push(new Player("Two", 2, 2));

            dumpChanges(state);

            let dump: any = dumpChanges(state);
            assert.strictEqual(
                JSON.stringify(dump),
                '{"ops":{"ADD":9},"refs":["refId#0","refId#1","refId#2","refId#3"]}',
            );

            // discard changes
            state.encode();

            state.arrayOfPlayers.splice(1);
            dump = dumpChanges(state);

            assert.strictEqual(
                JSON.stringify(dump),
                '{"ops":{"DELETE":1},"refs":["refId#1"]}',
            );
        });

    });

    describe("debugRefIds", () => {

        it("should be able to debug Decoder refIds", () => {
            const state = new State();
            state.arrayOfPlayers = new ArraySchema<Player>();
            state.arrayOfPlayers.push(new Player("One", 1, 1));
            state.arrayOfPlayers.push(new Player("Two", 2, 2));

            const decoded = createInstanceFromReflection(state);
            decoded.decode(state.encode());

            const extractRefIds = (debugRefIds: string) =>
                Array.from(debugRefIds.matchAll(/\(refId: ([0-9]+)\)/g)).map(entry => entry[0]);

            assert.deepStrictEqual(extractRefIds(Schema.debugRefIds(state)), extractRefIds(Schema.debugRefIdsDecoder(getDecoder(decoded))))
        });

    });

});