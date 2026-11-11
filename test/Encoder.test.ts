import * as assert from "assert";
import { MapSchema, Schema, type, ArraySchema, defineTypes, Reflection, Encoder, $changes } from "../src";

import { State, Player, getCallbacks, assertDeepStrictEqualEncodeAll, createInstanceFromReflection } from "./Schema";

describe("Encoder", () => {
    const bufferSize = Encoder.BUFFER_SIZE;

    before(() => Encoder.BUFFER_SIZE = 16);
    after(() => Encoder.BUFFER_SIZE = bufferSize);

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

    it("should throw the same error when a child's field is an own property", () => {
        class Inventory extends Schema {
            @type(["string"]) slots = new ArraySchema<string>();
        }
        class Hero extends Schema {
            @type(Inventory) inventory: Inventory;
            @type({ map: Inventory }) stash = new MapSchema<Inventory>();
            @type([Inventory]) bags = new ArraySchema<Inventory>();
        }

        const encoder = new Encoder(new Hero());

        const inventory = new Inventory();
        Object.defineProperty(inventory, "slots", { value: new ArraySchema<string>(), writable: true, enumerable: true, configurable: true });

        assert.throws(() => encoder.state.inventory = inventory, /Inventory\.slots is an own property/);
        assert.throws(() => encoder.state.stash.set("a", inventory), /Inventory\.slots is an own property/);
        assert.throws(() => encoder.state.bags.push(inventory), /Inventory\.slots is an own property/);
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

});
