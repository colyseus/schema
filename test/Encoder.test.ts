import * as assert from "assert";
import { MapSchema, Schema, type, ArraySchema, defineTypes, Reflection, Encoder, $changes } from "../src";

import { State, Player, getCallbacks, assertDeepStrictEqualEncodeAll, createInstanceFromReflection } from "./Schema";
import { collected } from "./helpers/test_helpers";
import { encode, utf8LengthFallback } from "../src/encoding/encode";
import { decode } from "../src/encoding/decode";

describe("Encoder", () => {
    const bufferSize = Encoder.BUFFER_SIZE;

    before(() => Encoder.BUFFER_SIZE = 16);
    after(() => Encoder.BUFFER_SIZE = bufferSize);

    it("releases encoder state after attaching a child collection", async () => {
        assert.ok(await collected(() => {
            const state = new State();
            const encoder = new Encoder(state);
            state.arrayOfPlayers = new ArraySchema(new Player());
            return [state, encoder.root];
        }));
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

    it("should throw a clear error when a field is an own property (useDefineForClassFields)", () => {
        class Item extends Schema {
            @type("string") name: string;
        }
        class GameState extends Schema {
            @type({ map: Item }) items = new MapSchema<Item>();
        }

        // what `useDefineForClassFields: true` emits for a class field initializer
        const state = new GameState();
        Object.defineProperty(state, "items", { value: new MapSchema<Item>(), writable: true, enumerable: true, configurable: true });

        assert.throws(() => new Encoder(state), /GameState\.items is an own property.*"useDefineForClassFields": false/);
    });

    it("should throw the same error from encode() when a child's field is an own property", () => {
        class Inventory extends Schema {
            @type(["string"]) slots = new ArraySchema<string>();
        }
        class Hero extends Schema {
            @type(Inventory) inventory: Inventory;
            @type({ map: Inventory }) stash = new MapSchema<Inventory>();
            @type([Inventory]) bags = new ArraySchema<Inventory>();
        }

        const encoder = new Encoder(new Hero());

        const shadowed = () => {
            const inventory = new Inventory();
            Object.defineProperty(inventory, "slots", { value: new ArraySchema<string>(), writable: true, enumerable: true, configurable: true });
            return inventory;
        };
        const attachments: Array<() => void> = [
            () => encoder.state.inventory = shadowed(),
            () => encoder.state.stash.set("a", shadowed()),
            () => encoder.state.bags.push(shadowed()),
            () => encoder.state.bags[0] = shadowed(),
            () => encoder.state.bags.unshift(shadowed()),
        ];

        for (const attach of attachments) {
            assert.doesNotThrow(attach);
            assert.throws(() => encoder.encode(), /Inventory\.slots is an own property/);
            encoder.discardChanges();
        }
    });

    it("should keep syncing the subtree when the error is caught", () => {
        class Tag extends Schema {
            @type("number") level: number = 1;
        }
        class Item extends Schema {
            @type("string") name: string;
            @type(Tag) tag = new Tag();
        }
        class GameState extends Schema {
            @type("string") title: string = "root";
            @type(Item) item: Item;
            @type({ map: Item }) items = new MapSchema<Item>();
            @type([Item]) list = new ArraySchema<Item>();
        }

        const state = new GameState();
        const decodedState = createInstanceFromReflection(state);
        decodedState.decode(state.encode());

        const shadowed = () => {
            const item = new Item();
            Object.defineProperty(item, "name", { value: "a", writable: true, enumerable: true, configurable: true });
            return item;
        };
        state.item = shadowed();
        state.items.set("a", shadowed());
        state.list.push(new Item());
        state.list.unshift(shadowed());
        state.list[1] = shadowed();

        // thrown once, then the queued changes encode as before
        assert.throws(() => state.encode(), /Item\.name is an own property/);
        decodedState.decode(state.encode());

        for (const item of [decodedState.item, decodedState.items.get("a"), decodedState.list[0], decodedState.list[1]]) {
            assert.ok(item instanceof Schema);
            assert.notStrictEqual(item, decodedState);
            assert.strictEqual(item.tag.level, 1);
        }
        assert.strictEqual(decodedState.list.length, 2);
    });

    it("should not check children added to a collection with no encoder (client-side)", () => {
        class Inventory extends Schema {
            @type(["string"]) slots = new ArraySchema<string>();
        }
        const inventory = new Inventory();
        Object.defineProperty(inventory, "slots", { value: new ArraySchema<string>(), writable: true, enumerable: true, configurable: true });

        class Hero extends Schema {
            @type({ map: Inventory }) stash = new MapSchema<Inventory>();
        }
        const hero = new Hero();
        assert.doesNotThrow(() => hero.stash.set("a", inventory));

        // still caught once the tree gets an encoder
        assert.throws(() => new Encoder(hero), /Inventory\.slots is an own property/);
    });

    describe("strings with lone surrogates", () => {
        // e.g. a string sliced mid-emoji
        const cases: Array<[string, string]> = [
            ["\uD83D", "\uFFFD"],
            ["\uDE00", "\uFFFD"],
            ["a\uD83Db", "a\uFFFDb"],
            ["x\uDE00y", "x\uFFFDy"],
            ["\uDE00\uD83D", "\uFFFD\uFFFD"],
            ["ok \uD83D\uDE00", "ok \uD83D\uDE00"],
        ];

        it("should write the same bytes as TextEncoder", () => {
            for (const [value] of cases) {
                const bytes: number[] = [];
                encode.utf8Write(bytes, value, { offset: 0 });
                assert.deepStrictEqual(bytes, Array.from(new TextEncoder().encode(value)), JSON.stringify(value));
            }
        });

        it("should count the same length in the browser fallback as Buffer.byteLength", () => {
            for (const [value] of cases) {
                assert.strictEqual(utf8LengthFallback(value), Buffer.byteLength(value), JSON.stringify(value));
            }
        });

        it("should not corrupt the values encoded after it", () => {
            for (const [value, expected] of cases) {
                const bytes: number[] = [];
                const it = { offset: 0 };
                encode.string(bytes, value, it);
                encode.string(bytes, "next", it);
                encode.number(bytes, 42, it);

                const readIt = { offset: 0 };
                assert.strictEqual(decode.string(bytes, readIt), expected, JSON.stringify(value));
                assert.strictEqual(decode.string(bytes, readIt), "next", JSON.stringify(value));
                assert.strictEqual(decode.number(bytes, readIt), 42, JSON.stringify(value));
                assert.strictEqual(readIt.offset, bytes.length, JSON.stringify(value));
            }
        });

        it("should decode the fields after a truncated name", () => {
            const state = new Player("Bob \uD83D", 42, 7);

            const decodedState = createInstanceFromReflection(state);
            decodedState.decode(state.encodeAll());

            assert.strictEqual(decodedState.name, "Bob \uFFFD");
            assert.strictEqual(decodedState.x, 42);
            assert.strictEqual(decodedState.y, 7);
        });
    });

});
