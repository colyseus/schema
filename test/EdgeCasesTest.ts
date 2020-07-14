import * as assert from "assert";
import * as nanoid from "nanoid";
import { MapSchema, Schema, type, ArraySchema, dumpChanges, defineTypes, Reflection, Context } from "../src";

import { State, Player } from "./Schema";

describe("Edge cases", () => {
    it("Schema should support more than 256 fields", () => {
        const maxFields = 1000;
        class State extends Schema {};

        const schema = {};
        for (let i = 0; i < maxFields; i++) { schema[`field_${i}`] = "string"; }
        defineTypes(State, schema);

        const state = new State();
        for (let i = 0; i < maxFields; i++) { state[`field_${i}`] = "value " + i; }

        const decodedState = Reflection.decode(Reflection.encode(state));
        decodedState.decode(state.encode());

        for (let i = 0; i < maxFields; i++) {
            assert.equal("value " + i, decodedState[`field_${i}`]);
        }
    });

    it("Should support up to 255 schema types", () => {
        const maxSchemaTypes = 255;
        const context = new Context();
        const type = Context.create(context);

        class State extends Schema {}

        const schemas: any = {};

        for (let i = 0; i < maxSchemaTypes; i++) {
            class Child extends Schema { @type("string") str: string; };
            schemas[i] = Child;
            defineTypes(State, { [`field_${i}`]: Child, }, context);
        }

        const state = new State();
        for (let i = 0; i < maxSchemaTypes; i++) {
            const child = new schemas[i]();
            child.str = "value " + i;
            state[`field_${i}`] = child;
        }

        const decodedState = Reflection.decode(Reflection.encode(state));
        decodedState.decode(state.encode());

        for (let i = 0; i < maxSchemaTypes; i++) {
            assert.equal("value " + i, decodedState[`field_${i}`].str);
        }
    });

    it("NIL check should not collide", () => {
        class State extends Schema {
            @type("int32") num: number;
            @type({ map: "int32" }) mapOfNum = new MapSchema<number>();
            @type(["int32"]) arrayOfNum = new ArraySchema<number>();
        }

        const state = new State();
        state.num = 3519;
        state.mapOfNum['one'] = 3519;
        state.arrayOfNum[0] = 3519;

        const decodedState = new State();
        decodedState.decode(state.encode());

        /**
         * 3520 is encoded as [192, 13, 0, 0]
         * (192 is the NIL byte indicator)
         */
        state.num = 3520;
        state.mapOfNum['one'] = 3520;
        state.arrayOfNum[0] = 3520;

        decodedState.decode(state.encode());

        assert.deepEqual(decodedState.toJSON(), {
            num: 3520,
            mapOfNum: { one: 3520 },
            arrayOfNum: [3520]
        });

        state.num = undefined;
        delete state.mapOfNum['one'];
        state.arrayOfNum.pop();

        decodedState.decode(state.encode());

        assert.deepEqual(decodedState.toJSON(), {
            mapOfNum: {},
            arrayOfNum: []
        });
    });

    it("string: containing specific UTF-8 characters", () => {
        let bytes: number[];

        const state = new State();
        const decodedState = new State();

        state.fieldString = "гхб";
        bytes = state.encode();
        decodedState.decode(bytes);
        assert.equal("гхб", decodedState.fieldString);

        state.fieldString = "Пуредоминаце";
        bytes = state.encode();
        decodedState.decode(bytes);
        assert.equal("Пуредоминаце", decodedState.fieldString);

        state.fieldString = "未知の選手";
        bytes = state.encode();
        decodedState.decode(bytes);
        assert.equal("未知の選手", decodedState.fieldString);

        state.fieldString = "알 수없는 플레이어";
        bytes = state.encode();
        decodedState.decode(bytes);
        assert.equal("알 수없는 플레이어", decodedState.fieldString);
    });

    it("MapSchema: index with high number of items should be preserved", () => {
        const state = new State();
        state.mapOfPlayers = new MapSchema<Player>();

        state.encodeAll(); // new client joining

        let i = 0;

        const decodedState1 = new State();
        decodedState1.decode(state.encodeAll()); // new client joining
        state.mapOfPlayers[nanoid(8)] = new Player("Player " + i++, i++, i++);

        const decodedState2 = new State();
        state.mapOfPlayers[nanoid(8)] = new Player("Player " + i++, i++, i++);
        decodedState2.decode(state.encodeAll()); // new client joining

        const decodedState3 = new State();
        decodedState3.decode(state.encodeAll()); // new client joining
        state.mapOfPlayers[nanoid(8)] = new Player("Player " + i++, i++, i++);

        const encoded = state.encode(); // patch state
        decodedState1.decode(encoded);
        decodedState2.decode(encoded);
        decodedState3.decode(encoded);

        const decodedState4 = new State();
        state.mapOfPlayers[nanoid(8)] = new Player("Player " + i++, i++, i++);
        decodedState4.decode(state.encodeAll()); // new client joining

        assert.equal(JSON.stringify(decodedState1), JSON.stringify(decodedState2));
        assert.equal(JSON.stringify(decodedState2), JSON.stringify(decodedState3));

        decodedState3.decode(state.encode()); // patch existing client.
        assert.equal(JSON.stringify(decodedState3), JSON.stringify(decodedState4));
    });
});
