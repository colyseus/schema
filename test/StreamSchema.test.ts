import * as assert from "assert";
import { Schema, type, ArraySchema, StreamSchema, StateView, schema, t, SchemaType } from "../src";
import {
    createClientWithView,
    encodeMultiple,
    getEncoder,
} from "./Schema";

describe("Type: StreamSchema", () => {

    it("add() Schema instances and encode via view", () => {
        class Entity extends Schema {
            @type("number") x: number = 0;
            @type("number") y: number = 0;
        }
        class State extends Schema {
            @type({ stream: Entity }) entities = new StreamSchema<Entity>();
        }

        const state = new State();
        const encoder = getEncoder(state);

        const client = createClientWithView(state);
        client.view.add(state);

        state.entities.add(new Entity().assign({ x: 1, y: 1 }));
        state.entities.add(new Entity().assign({ x: 2, y: 2 }));

        encodeMultiple(encoder, state, [client]);

        assert.strictEqual(client.state.entities.length, 2);
        const arr = client.state.entities.toArray();
        assert.strictEqual(arr[0].x, 1);
        assert.strictEqual(arr[1].x, 2);
    });

    it("maxPerTick caps ADDs per tick per view", () => {
        class Entity extends Schema {
            @type("number") id: number = 0;
        }
        class State extends Schema {
            @type({ stream: Entity }) entities = new StreamSchema<Entity>();
        }

        const state = new State();
        state.entities.maxPerTick = 3;
        const encoder = getEncoder(state);

        const client = createClientWithView(state);
        client.view.add(state);

        for (let i = 0; i < 10; i++) {
            state.entities.add(new Entity().assign({ id: i }));
        }

        // Tick 1: 3 added
        encodeMultiple(encoder, state, [client]);
        assert.strictEqual(client.state.entities.length, 3);

        // Tick 2: 6 added total (3 more)
        encodeMultiple(encoder, state, [client]);
        assert.strictEqual(client.state.entities.length, 6);

        // Tick 3: 9 total
        encodeMultiple(encoder, state, [client]);
        assert.strictEqual(client.state.entities.length, 9);

        // Tick 4: 10 total (1 more)
        encodeMultiple(encoder, state, [client]);
        assert.strictEqual(client.state.entities.length, 10);
    });

    it("streamPriority selects top-N by descending priority", () => {
        class Entity extends Schema {
            @type("number") id: number = 0;
        }
        class State extends Schema {
            @type({ stream: Entity }) entities = new StreamSchema<Entity>();
        }

        const state = new State();
        state.entities.maxPerTick = 2;
        const encoder = getEncoder(state);

        const client = createClientWithView(state);
        // Prioritize higher-id entities first.
        client.view.streamPriority = (_stream, el: Entity) => el.id;
        client.view.add(state);

        state.entities.add(new Entity().assign({ id: 1 }));
        state.entities.add(new Entity().assign({ id: 50 }));
        state.entities.add(new Entity().assign({ id: 10 }));
        state.entities.add(new Entity().assign({ id: 99 }));

        encodeMultiple(encoder, state, [client]);

        // Top 2 by priority: 99 and 50
        const ids = client.state.entities.toArray().map((e) => e.id).sort((a, b) => a - b);
        assert.deepStrictEqual(ids, [50, 99]);
    });

    it("remove() before sent drops silently (no wire op)", () => {
        class Entity extends Schema {
            @type("number") id: number = 0;
        }
        class State extends Schema {
            @type({ stream: Entity }) entities = new StreamSchema<Entity>();
        }

        const state = new State();
        state.entities.maxPerTick = 1;
        const encoder = getEncoder(state);

        const client = createClientWithView(state);
        client.view.add(state);

        const e1 = new Entity().assign({ id: 1 });
        const e2 = new Entity().assign({ id: 2 });
        state.entities.add(e1);
        state.entities.add(e2);

        // Remove e2 BEFORE any encode — it was in pending, never sent.
        state.entities.remove(e2);

        encodeMultiple(encoder, state, [client]);
        encodeMultiple(encoder, state, [client]);

        // Client sees only e1.
        assert.strictEqual(client.state.entities.length, 1);
        assert.strictEqual(client.state.entities.toArray()[0].id, 1);
    });

    it("remove() after sent emits DELETE next tick", () => {
        class Entity extends Schema {
            @type("number") id: number = 0;
        }
        class State extends Schema {
            @type({ stream: Entity }) entities = new StreamSchema<Entity>();
        }

        const state = new State();
        const encoder = getEncoder(state);

        const client = createClientWithView(state);
        client.view.add(state);

        const e1 = new Entity().assign({ id: 1 });
        state.entities.add(e1);

        encodeMultiple(encoder, state, [client]);
        assert.strictEqual(client.state.entities.length, 1);

        state.entities.remove(e1);

        encodeMultiple(encoder, state, [client]);
        assert.strictEqual(client.state.entities.length, 0);
    });

    it("mutable elements propagate field changes after being sent", () => {
        class Entity extends Schema {
            @type("number") x: number = 0;
        }
        class State extends Schema {
            @type({ stream: Entity }) entities = new StreamSchema<Entity>();
        }

        const state = new State();
        const encoder = getEncoder(state);

        const client = createClientWithView(state);
        client.view.add(state);

        const e = new Entity().assign({ x: 0 });
        state.entities.add(e);

        encodeMultiple(encoder, state, [client]);
        assert.strictEqual(client.state.entities.toArray()[0].x, 0);

        e.x = 42;
        encodeMultiple(encoder, state, [client]);
        assert.strictEqual(client.state.entities.toArray()[0].x, 42);
    });

    it("static elements suppress field changes after being sent", () => {
        // schema() factory builder needed because `.static()` chains from
        // `t.stream(...)` — @type({ stream: Entity }) can't express it.
        const Entity = schema({ x: t.number() }, "Entity");
        const State = schema({ entities: t.stream(Entity).static() }, "State");
        type EntityT = SchemaType<typeof Entity>;

        const state: SchemaType<typeof State> = new State();
        const encoder = getEncoder(state);

        const client = createClientWithView(state);
        client.view.add(state);

        const e: EntityT = new Entity();
        e.x = 7;
        state.entities.add(e);

        encodeMultiple(encoder, state, [client]);
        assert.strictEqual(client.state.entities.toArray()[0].x, 7);

        // Mutate after send — static suppression means this should be a no-op.
        e.x = 999;
        encodeMultiple(encoder, state, [client]);
        assert.strictEqual(client.state.entities.toArray()[0].x, 7);
    });

    it("late-joining view receives current backlog spread over ticks", () => {
        class Entity extends Schema {
            @type("number") id: number = 0;
        }
        class State extends Schema {
            @type({ stream: Entity }) entities = new StreamSchema<Entity>();
        }

        const state = new State();
        state.entities.maxPerTick = 2;
        const encoder = getEncoder(state);

        // Populate the stream BEFORE the view exists.
        for (let i = 0; i < 5; i++) {
            state.entities.add(new Entity().assign({ id: i }));
        }

        // Some initial "warmup" encode so the state is serialized.
        encoder.discardChanges();

        // New client joins mid-session.
        const client = createClientWithView(state);
        client.view.add(state);

        encodeMultiple(encoder, state, [client]);
        assert.strictEqual(client.state.entities.length, 2);

        encodeMultiple(encoder, state, [client]);
        assert.strictEqual(client.state.entities.length, 4);

        encodeMultiple(encoder, state, [client]);
        assert.strictEqual(client.state.entities.length, 5);
    });

    describe("ECS structure", () => {

        it("entity stream → components array → polymorphic component schemas → nested schemas/primitives", () => {
            // Leaf nested schema (Schema child of a component).
            class Vec2 extends Schema {
                @type("number") x: number = 0;
                @type("number") y: number = 0;
            }
            // Base component — subclasses add their own fields.
            class Component extends Schema {
                @type("string") kind: string = "";
            }
            class Position extends Component {
                @type("number") x: number = 0;
                @type("number") y: number = 0;
            }
            class Velocity extends Component {
                @type("number") dx: number = 0;
                @type("number") dy: number = 0;
            }
            class Sprite extends Component {
                @type("string") texture: string = "";
                @type(Vec2) offset: Vec2 = new Vec2();
            }
            class Entity extends Schema {
                @type("string") name: string = "";
                @type([Component]) components = new ArraySchema<Component>();
            }
            class State extends Schema {
                @type({ stream: Entity }) entities = new StreamSchema<Entity>();
            }

            const state = new State();
            const encoder = getEncoder(state);

            const client = createClientWithView(state);
            client.view.add(state);

            // Entity 1: player with Position, Velocity, Sprite (nested Vec2).
            const player = new Entity().assign({ name: "player" });
            player.components.push(new Position().assign({ kind: "position", x: 10, y: 20 }));
            player.components.push(new Velocity().assign({ kind: "velocity", dx: 1, dy: -1 }));
            const sprite = new Sprite().assign({ kind: "sprite", texture: "warrior.png" });
            sprite.offset.assign({ x: 5, y: 7 });
            player.components.push(sprite);
            state.entities.add(player);

            // Entity 2: enemy with just a Position.
            const enemy = new Entity().assign({ name: "enemy" });
            enemy.components.push(new Position().assign({ kind: "position", x: 100, y: 50 }));
            state.entities.add(enemy);

            encodeMultiple(encoder, state, [client]);

            const decodedEntities = client.state.entities.toArray();
            assert.strictEqual(decodedEntities.length, 2);

            // Player
            const dPlayer = decodedEntities[0];
            assert.strictEqual(dPlayer.name, "player");
            assert.strictEqual(dPlayer.components.length, 3);

            // Position (polymorphic subclass of Component)
            const dPos = dPlayer.components[0] as Position;
            assert.strictEqual(dPos.kind, "position");
            assert.strictEqual(dPos.x, 10);
            assert.strictEqual(dPos.y, 20);

            // Velocity
            const dVel = dPlayer.components[1] as Velocity;
            assert.strictEqual(dVel.kind, "velocity");
            assert.strictEqual(dVel.dx, 1);
            assert.strictEqual(dVel.dy, -1);

            // Sprite — includes a nested Vec2 schema child.
            const dSprite = dPlayer.components[2] as Sprite;
            assert.strictEqual(dSprite.kind, "sprite");
            assert.strictEqual(dSprite.texture, "warrior.png");
            assert.strictEqual(dSprite.offset.x, 5);
            assert.strictEqual(dSprite.offset.y, 7);

            // Enemy
            const dEnemy = decodedEntities[1];
            assert.strictEqual(dEnemy.name, "enemy");
            assert.strictEqual(dEnemy.components.length, 1);
            assert.strictEqual((dEnemy.components[0] as Position).x, 100);
        });

        it("ECS: low maxPerTick spreads nested-child entities across ticks without losing state", () => {
            // Regression: entities not selected in tick 1 have dirty state
            // in root.changes that `discardChanges` resets + flips
            // `isNew=false`. On a later tick, `view.add(entity)` recurses
            // and uses `forEachLive` (structural walk) rather than the
            // reset recorder — so children's full state still arrives.
            class Vec2 extends Schema {
                @type("number") x: number = 0;
                @type("number") y: number = 0;
            }
            class Component extends Schema {
                @type("string") kind: string = "";
            }
            class Sprite extends Component {
                @type("string") texture: string = "";
                @type(Vec2) offset: Vec2 = new Vec2();
            }
            class Entity extends Schema {
                @type("string") name: string = "";
                @type([Component]) components = new ArraySchema<Component>();
            }
            class State extends Schema {
                @type({ stream: Entity }) entities = new StreamSchema<Entity>();
            }

            const state = new State();
            state.entities.maxPerTick = 2;
            const encoder = getEncoder(state);
            const client = createClientWithView(state);
            client.view.add(state);

            // 5 entities × 2 components each = 10 component trees.
            // maxPerTick=2 → need 3 ticks to drain.
            const makeEntity = (name: string, tex: string, ox: number) => {
                const e = new Entity().assign({ name });
                e.components.push(new Component().assign({ kind: "tag" }));
                const sprite = new Sprite().assign({ kind: "sprite", texture: tex });
                sprite.offset.assign({ x: ox, y: ox + 1 });
                e.components.push(sprite);
                return e;
            };

            const entities: Entity[] = [];
            for (let i = 0; i < 5; i++) {
                const e = makeEntity(`e${i}`, `t${i}.png`, i * 10);
                entities.push(e);
                state.entities.add(e);
            }

            // Tick 1: 2 emitted (positions 0, 1).
            encodeMultiple(encoder, state, [client]);
            assert.strictEqual(client.state.entities.length, 2);

            // Tick 2: 2 more (positions 2, 3).
            encodeMultiple(encoder, state, [client]);
            assert.strictEqual(client.state.entities.length, 4);

            // Tick 3: final one (position 4).
            encodeMultiple(encoder, state, [client]);
            assert.strictEqual(client.state.entities.length, 5);

            // Verify each entity still has its full nested state — including
            // children that were enqueued + `discardChanges`-reset before
            // their parent entity was priority-selected.
            const decoded = client.state.entities.toArray();
            for (let i = 0; i < 5; i++) {
                const e = decoded[i];
                assert.strictEqual(e.name, `e${i}`);
                assert.strictEqual(e.components.length, 2);
                assert.strictEqual(e.components[0].kind, "tag");

                const sprite = e.components[1] as Sprite;
                assert.strictEqual(sprite.kind, "sprite");
                assert.strictEqual(sprite.texture, `t${i}.png`);
                assert.strictEqual(sprite.offset.x, i * 10);
                assert.strictEqual(sprite.offset.y, i * 10 + 1);
            }
        });

        it("ECS: mutations after initial send propagate through the nested tree", () => {
            class Vec2 extends Schema {
                @type("number") x: number = 0;
                @type("number") y: number = 0;
            }
            class Component extends Schema {
                @type("string") kind: string = "";
            }
            class Sprite extends Component {
                @type("string") texture: string = "";
                @type(Vec2) offset: Vec2 = new Vec2();
            }
            class Entity extends Schema {
                @type("string") name: string = "";
                @type([Component]) components = new ArraySchema<Component>();
            }
            class State extends Schema {
                @type({ stream: Entity }) entities = new StreamSchema<Entity>();
            }

            const state = new State();
            const encoder = getEncoder(state);
            const client = createClientWithView(state);
            client.view.add(state);

            const e = new Entity().assign({ name: "e1" });
            const sprite = new Sprite().assign({ kind: "sprite", texture: "v1.png" });
            sprite.offset.assign({ x: 1, y: 2 });
            e.components.push(sprite);
            state.entities.add(e);

            encodeMultiple(encoder, state, [client]);
            {
                const s = client.state.entities.toArray()[0].components[0] as Sprite;
                assert.strictEqual(s.texture, "v1.png");
                assert.strictEqual(s.offset.x, 1);
            }

            // Mutate a nested-schema field (Vec2.x) AND a primitive on the
            // component itself (texture). Both should propagate.
            sprite.texture = "v2.png";
            sprite.offset.x = 99;

            encodeMultiple(encoder, state, [client]);
            {
                const s = client.state.entities.toArray()[0].components[0] as Sprite;
                assert.strictEqual(s.texture, "v2.png");
                assert.strictEqual(s.offset.x, 99);
                assert.strictEqual(s.offset.y, 2);
            }
        });

    });

    describe("broadcast mode (no StateView)", () => {

        it("add() + encode() without a view syncs elements", () => {
            class Entity extends Schema {
                @type("number") x: number = 0;
            }
            class State extends Schema {
                @type({ stream: Entity }) entities = new StreamSchema<Entity>();
            }

            const state = new State();
            const encoder = getEncoder(state);

            state.entities.add(new Entity().assign({ x: 1 }));
            state.entities.add(new Entity().assign({ x: 2 }));

            const decoded = new State();
            decoded.decode(state.encodeAll());
            decoded.decode(state.encode());

            assert.strictEqual(decoded.entities.length, 2);
            const arr = decoded.entities.toArray();
            assert.strictEqual(arr[0].x, 1);
            assert.strictEqual(arr[1].x, 2);
        });

        it("maxPerTick caps broadcast ADDs per shared tick", () => {
            class Entity extends Schema {
                @type("number") id: number = 0;
            }
            class State extends Schema {
                @type({ stream: Entity }) entities = new StreamSchema<Entity>();
            }

            const state = new State();
            state.entities.maxPerTick = 3;
            const encoder = getEncoder(state);

            const decoded = new State();
            decoded.decode(state.encodeAll());

            for (let i = 0; i < 10; i++) {
                state.entities.add(new Entity().assign({ id: i }));
            }

            decoded.decode(state.encode());
            assert.strictEqual(decoded.entities.length, 3);

            decoded.decode(state.encode());
            assert.strictEqual(decoded.entities.length, 6);

            decoded.decode(state.encode());
            assert.strictEqual(decoded.entities.length, 9);

            decoded.decode(state.encode());
            assert.strictEqual(decoded.entities.length, 10);
        });

        it("broadcast remove() before sent drops silently", () => {
            class Entity extends Schema {
                @type("number") id: number = 0;
            }
            class State extends Schema {
                @type({ stream: Entity }) entities = new StreamSchema<Entity>();
            }

            const state = new State();
            state.entities.maxPerTick = 1;
            const encoder = getEncoder(state);

            const decoded = new State();
            decoded.decode(state.encodeAll());

            const e1 = new Entity().assign({ id: 1 });
            const e2 = new Entity().assign({ id: 2 });
            state.entities.add(e1);
            state.entities.add(e2);
            state.entities.remove(e2);

            decoded.decode(state.encode());
            decoded.decode(state.encode());

            assert.strictEqual(decoded.entities.length, 1);
            assert.strictEqual(decoded.entities.toArray()[0].id, 1);
        });

        it("broadcast remove() after sent emits DELETE", () => {
            class Entity extends Schema {
                @type("number") id: number = 0;
            }
            class State extends Schema {
                @type({ stream: Entity }) entities = new StreamSchema<Entity>();
            }

            const state = new State();
            const encoder = getEncoder(state);

            const decoded = new State();
            decoded.decode(state.encodeAll());

            const e1 = new Entity().assign({ id: 1 });
            state.entities.add(e1);

            decoded.decode(state.encode());
            assert.strictEqual(decoded.entities.length, 1);

            state.entities.remove(e1);
            decoded.decode(state.encode());
            assert.strictEqual(decoded.entities.length, 0);
        });

        it("broadcast mutable elements propagate field changes", () => {
            class Entity extends Schema {
                @type("number") x: number = 0;
            }
            class State extends Schema {
                @type({ stream: Entity }) entities = new StreamSchema<Entity>();
            }

            const state = new State();
            const encoder = getEncoder(state);

            const decoded = new State();
            decoded.decode(state.encodeAll());

            const e = new Entity().assign({ x: 0 });
            state.entities.add(e);

            decoded.decode(state.encode());
            assert.strictEqual(decoded.entities.toArray()[0].x, 0);

            e.x = 42;
            decoded.decode(state.encode());
            assert.strictEqual(decoded.entities.toArray()[0].x, 42);
        });

        it("broadcast static elements suppress field changes", () => {
            const Entity = schema({ x: t.number() }, "Entity");
            const State = schema({ entities: t.stream(Entity).static() }, "State");

            const state: SchemaType<typeof State> = new State();
            const encoder = getEncoder(state);

            const decoded: SchemaType<typeof State> = new State();
            decoded.decode(state.encodeAll());

            const e: SchemaType<typeof Entity> = new Entity();
            e.x = 7;
            state.entities.add(e);

            decoded.decode(state.encode());
            assert.strictEqual(decoded.entities.toArray()[0].x, 7);

            e.x = 999;
            decoded.decode(state.encode());
            assert.strictEqual(decoded.entities.toArray()[0].x, 7);
        });

    });

    it("two views with different priority callbacks see different orderings", () => {
        class Entity extends Schema {
            @type("number") id: number = 0;
        }
        class State extends Schema {
            @type({ stream: Entity }) entities = new StreamSchema<Entity>();
        }

        const state = new State();
        state.entities.maxPerTick = 2;
        const encoder = getEncoder(state);

        const clientA = createClientWithView(state);
        clientA.view.streamPriority = (_s, el: Entity) => el.id; // highest id first
        clientA.view.add(state);

        const clientB = createClientWithView(state);
        clientB.view.streamPriority = (_s, el: Entity) => -el.id; // lowest id first
        clientB.view.add(state);

        state.entities.add(new Entity().assign({ id: 1 }));
        state.entities.add(new Entity().assign({ id: 2 }));
        state.entities.add(new Entity().assign({ id: 3 }));
        state.entities.add(new Entity().assign({ id: 4 }));

        encodeMultiple(encoder, state, [clientA, clientB]);

        // First tick: A sees [3, 4] (top 2 by desc id); B sees [1, 2].
        const idsA = clientA.state.entities.toArray().map((e) => e.id).sort((a, b) => a - b);
        const idsB = clientB.state.entities.toArray().map((e) => e.id).sort((a, b) => a - b);
        assert.deepStrictEqual(idsA, [3, 4]);
        assert.deepStrictEqual(idsB, [1, 2]);
    });

});
