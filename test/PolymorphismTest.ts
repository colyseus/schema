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

class EntityHolder extends Schema {
    @type(Entity, context) entity: Entity;
}

class State extends Schema {
    @type(Entity, context) entity: Entity;
    @type(EntityHolder, context) entityHolder = new EntityHolder();
    @type([ Entity ], context) arrayOfEntities = new ArraySchema<Entity>();
    @type({ map: Entity }, context) mapOfEntities = new MapSchema<Entity>();
}

describe("Polymorphism", () => {
    function createEntity() {
        const entity = new Entity();
        entity.x = 1;
        entity.y = 2;
        return entity;
    }

    function createPlayer() {
        const player =  new Player();
        player.x = 100;
        player.y = 200;
        player.name = "Jake";
        player.lvl = 5;
        return player;
    }

    function createEnemy () {
        const enemy =  new Enemy();
        enemy.x = 10;
        enemy.y = 20;
        enemy.power = 100;
        return enemy;
    }

    it("should encode the correct class ref directly", () => {
        const state = new State();

        state.entityHolder.entity = createPlayer();

        const decodedState = new State();
        decodedState.decode(state.encodeAll());
        assert.ok(decodedState.entityHolder.entity instanceof Player);
        assert.ok(decodedState.entityHolder.entity instanceof Entity);

        const decodedReflectedState: any = Reflection.decode(Reflection.encode(state));
        decodedReflectedState.decode(state.encodeAll());
        assert.strictEqual(decodedReflectedState.entityHolder.entity.x, 100);
        assert.strictEqual(decodedReflectedState.entityHolder.entity.y, 200);
        assert.strictEqual(decodedReflectedState.entityHolder.entity.name, "Jake");
        assert.strictEqual(decodedReflectedState.entityHolder.entity.lvl, 5);

        state.entityHolder.entity = null;
        decodedState.decode(state.encode());

        assert.ok(!decodedState.entityHolder.entity);

        state.entityHolder.entity = createEnemy();

        decodedState.decode(state.encode());
        assert.ok(decodedState.entityHolder.entity instanceof Enemy);
        assert.ok(decodedState.entityHolder.entity instanceof Entity);
    });

    it("should encode the correct class inside an array", () => {
        const state = new State();
        state.arrayOfEntities.push(createEntity());
        state.arrayOfEntities.push(createPlayer());
        state.arrayOfEntities.push(createEnemy());

        const decodedState = new State();
        decodedState.decode(state.encodeAll());
        assert.ok(decodedState.arrayOfEntities[0] instanceof Entity);
        assert.ok(decodedState.arrayOfEntities[1] instanceof Player);
        assert.ok(decodedState.arrayOfEntities[2] instanceof Enemy);

        state.arrayOfEntities.push(createPlayer());
        decodedState.decode(state.encode());

        assert.ok(decodedState.arrayOfEntities[3] instanceof Entity);
        assert.ok(decodedState.arrayOfEntities[3] instanceof Player);
    });

    it("should encode the correct class inside a map", () => {
        const state = new State();
        state.mapOfEntities['entity'] = createEntity();
        state.mapOfEntities['player'] = createPlayer();
        state.mapOfEntities['enemy'] = createEnemy();

        const decodedState = new State();
        decodedState.decode(state.encodeAll());
        assert.ok(decodedState.mapOfEntities['entity'] instanceof Entity);
        assert.ok(decodedState.mapOfEntities['player'] instanceof Player);
        assert.ok(decodedState.mapOfEntities['enemy'] instanceof Enemy);

        state.mapOfEntities['player-2'] = createPlayer();
        decodedState.decode(state.encode());
        assert.ok(decodedState.mapOfEntities['player-2'] instanceof Entity);
        assert.ok(decodedState.mapOfEntities['player-2'] instanceof Player);
    });

    it("should allow generics", () => {
        abstract class BaseConfig extends Schema {
            @type("string") default: string = "default";
        }
        class ConcreteConfig extends BaseConfig {
            @type("number") specific: number = 0;
        }
        class GameRoomState<RoomConfigType extends BaseConfig = any> extends Schema {
            @type(BaseConfig)
            roomConfig: RoomConfigType;
        }

        const state = new GameRoomState<ConcreteConfig>();
        state.roomConfig = new ConcreteConfig();
        state.roomConfig.specific = 20;

        const decodedState = new GameRoomState<ConcreteConfig>();
        decodedState.decode(state.encode());

        assert.strictEqual("default", decodedState.roomConfig.default);
        assert.strictEqual(20, decodedState.roomConfig.specific);
    });
});
