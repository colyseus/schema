import * as assert from "assert";
import { type, Context } from "../src/annotations";
import { ArraySchema, MapSchema, Reflection } from "../src";
import { Schema } from "../src/Schema";

const context = new Context();

class Entity extends Schema {
    @type("number", context) x: number;
    @type("number", context) y: number;
}

class Player extends Entity {
    @type("string", context) name: string;
    @type("number", context) lvl: number;
}

class Enemy extends Player {
    @type("number", context) power: number;
}

class State extends Schema {
    @type(Entity, context) entity: Entity;
    @type([ Entity ], context) arrayOfEntities = new ArraySchema<Entity>();
    @type({ map: Entity }, context) mapOfEntities = new MapSchema<Entity>();
}

describe("Polymorphism", () => {
    it("should encode the correct class reference directly", () => {
        const state = new State();

        const player =  new Player();
        player.x = 100;
        player.y = 200;
        player.name = "Jake";
        player.lvl = 5;

        state.entity = player;

        const decodedState = new State();
        decodedState.decode(state.encodeAll());
        assert.ok(decodedState.entity instanceof Player);
        assert.ok(decodedState.entity instanceof Entity);

        const decodedReflectedState: any = Reflection.decode(Reflection.encode(state));
        decodedReflectedState.decode(state.encodeAll());
        assert.equal(decodedReflectedState.entity.x, 100);
        assert.equal(decodedReflectedState.entity.y, 200);
        assert.equal(decodedReflectedState.entity.name, "Jake");
        assert.equal(decodedReflectedState.entity.lvl, 5);
    });
});
