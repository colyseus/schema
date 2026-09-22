import * as assert from "assert";

import { State, Player, getCallbacks, getEncoder, createInstanceFromReflection, getDecoder, assertDeepStrictEqualEncodeAll } from "./Schema";
import { ArraySchema, Schema, type, Reflection, $changes, $refId, Metadata, SetSchema, MapSchema } from "../src";
import { $numFields, $values } from "../src/types/symbols";
import { Encoder } from "../src/encoder/Encoder";
import { Decoder } from "../src/decoder/Decoder";

describe("Metadata Tests", () => {

    it("Metadata.setFields() on external class", () => {
        class RawState {
            x: number;
            y: number;
            constructor() {
                Schema.initialize(this);
            }
        }
        Metadata.setFields(RawState, { x: "number", y: "number" });

        class State extends Schema {
            @type(RawState) raw = new RawState();
        }

        const state = new State();
        state.raw.x = 10;
        state.raw.y = 20;

        const decodedState = createInstanceFromReflection(state);
        decodedState.decode(state.encodeAll());

        assert.strictEqual((RawState as any)[Symbol.metadata][$numFields], 1);
        assert.deepStrictEqual(decodedState.toJSON(), state.toJSON());
    });

    it("Metadata.setFields() on inherited external class", () => {
        class RawState {
            x: number;
            y: number;
            constructor() {
                Schema.initialize(this);
            }
        }
        Metadata.setFields(RawState, { x: "number", y: "number" });

        class Raw2State extends RawState {
            z: number;
            constructor() {
                super();
                Schema.initialize(this);
            }
        }
        Metadata.setFields(Raw2State, { z: "number" });

        class State extends Schema {
            @type(RawState) raw = new RawState();
            @type(Raw2State) raw2 = new Raw2State();
        }

        const state = new State();
        state.raw.x = 10;
        state.raw.y = 20;

        state.raw2.x = 10;
        state.raw2.y = 20;
        state.raw2.z = 30;

        const decodedState = createInstanceFromReflection(state);
        decodedState.decode(state.encodeAll());

        assert.strictEqual((Raw2State as any)[Symbol.metadata][$numFields], 2);
        assert.deepStrictEqual(decodedState.toJSON(), state.toJSON());
    });

    it("external class exposes $changes / $refId without own properties", () => {
        class RawState {
            x: number;
            constructor() {
                Schema.initialize(this);
            }
        }
        Metadata.setFields(RawState, { x: "number" });

        class State extends Schema {
            @type(RawState) raw = new RawState();
        }

        const state = new State();
        state.raw.x = 10;
        getEncoder(state); // attaches the tree: refIds are assigned

        const raw: any = state.raw;
        assert.ok(raw[$changes] !== undefined, "tree reachable through the accessor");
        assert.strictEqual(typeof raw[$refId], "number", "refId reachable through the accessor");
        assert.strictEqual(raw[$refId], raw[$changes].refId);

        // neither lives on the instance: invisible to deepStrictEqual / inspect
        const ownSymbols = Object.getOwnPropertySymbols(raw);
        assert.ok(!ownSymbols.includes($changes));
        assert.ok(!ownSymbols.includes($refId));

        const other: any = new RawState();
        other.x = 10;
        assert.deepStrictEqual(other, raw, "attached and detached instances compare by fields only");
    });

    it("should support nested external classes", () => {
        class Body {
            name: string;
            position: Vec2;
            rotation: Vec2;
        }
        class Vec2 {
            x: number;
            y: number;
        }
        Metadata.setFields(Body, {
            name: "string",
            position: Vec2,
            rotation: Vec2,
        });
        Metadata.setFields(Vec2, {
            x: "number",
            y: "number",
        });

        class State extends Schema {
            @type({ map: Body }) bodies = new MapSchema<Body>();
        }

        const state = new State();

        const body = new Body();
        Schema.initialize(body);

        body.name = "testing";
        body.position = new Vec2();
        Schema.initialize(body.position);

        body.position.x = 10;
        body.position.y = 20;

        body.rotation = new Vec2();
        Schema.initialize(body.rotation);

        body.rotation.x = 10;
        body.rotation.y = 20;

        state.bodies.set('one', body);

        const decodedState = createInstanceFromReflection(state);
        decodedState.decode(state.encode());

        assert.deepStrictEqual(decodedState.toJSON(), state.toJSON());
    });

    describe("Schema.initialize idempotence / tree.values contract (LEADS 07)", () => {
        it("per-inheritance-level initialize keeps a child assigned between the calls", () => {
            class Item { v: number; }
            Metadata.setFields(Item, { v: "number" });

            class Base {
                item: Item;
                constructor() {
                    Schema.initialize(this);
                    const item = new Item();
                    Schema.initialize(item);
                    item.v = 1;
                    this.item = item; // assigned BEFORE the subclass's initialize
                }
            }
            Metadata.setFields(Base, { item: Item });

            class Derived extends Base {
                n: number;
                constructor() {
                    super();
                    Schema.initialize(this);
                    this.n = 2;
                }
            }
            Metadata.setFields(Derived, { n: "number" });

            class Root extends Schema {
                @type(Derived) d = new Derived();
            }

            const state = new Root();
            const d: any = state.d;
            assert.strictEqual(d[$changes].values, d[$values], "tree.values === $values");
            assert.strictEqual(d.item.v, 1);

            const encoder = new Encoder(state);
            const decoded = createInstanceFromReflection(state, encoder);
            decoded.decode(encoder.encodeAll());
            assert.deepStrictEqual(decoded.toJSON(), { d: { item: { v: 1 }, n: 2 } });

            // incremental: the child is attached under the kept tree
            encoder.discardChanges();
            d.item.v = 5;
            decoded.decode(encoder.encode());
            encoder.discardChanges();
            assert.deepStrictEqual(decoded.toJSON(), { d: { item: { v: 5 }, n: 2 } });
        });

        it("a second initialize is a no-op on a Schema subclass", () => {
            const player: any = new Player("a", 1, 2);
            const tree = player[$changes];
            Schema.initialize(player);
            assert.strictEqual(player[$changes], tree);
            assert.strictEqual(tree.values, player[$values]);
            assert.deepStrictEqual(player.toJSON(), { name: "a", x: 1, y: 2 });
        });

        it("a second initialize is a no-op on an external class", () => {
            class Raw { x: number; }
            Metadata.setFields(Raw, { x: "number" });
            const raw: any = new Raw();
            Schema.initialize(raw);
            const tree = raw[$changes];
            raw.x = 10;
            Schema.initialize(raw);
            assert.strictEqual(raw[$changes], tree);
            assert.strictEqual(tree.values, raw[$values]);
            assert.strictEqual(raw.x, 10);
        });

        it("initialize on a decoder-built instance installs a real tree (encodable as root and as child)", () => {
            const state = new State();
            state.player = new Player("p", 3, 4);
            // decoder-built root + child (both carry decoder stubs)
            const decoded = State.initializeForDecoder();
            new Decoder(decoded).decode(state.encodeAll());
            assert.strictEqual((decoded as any)[$changes].isTracked, false);

            // as root
            Schema.initialize(decoded);
            assert.deepStrictEqual(decoded.player.toJSON(), { name: "p", x: 3, y: 4 }, "decoded values survive initialize");
            decoded.fieldString = "relay";
            const encoder = new Encoder(decoded);
            const copy = createInstanceFromReflection(decoded, encoder);
            copy.decode(encoder.encodeAll());
            assert.deepStrictEqual(copy.toJSON(), decoded.toJSON());
            assert.strictEqual(copy.toJSON().fieldString, "relay");

            // as child, under a fresh state
            const decoded2 = new State();
            new Decoder(decoded2).decode(state.encodeAll());
            const player: any = decoded2.player;
            assert.strictEqual(player[$changes].isTracked, false);
            Schema.initialize(player);
            assert.strictEqual(player.y, 4, "decoded values survive initialize");
            player.name = "q"; player.x = 5;
            const fresh = new State();
            fresh.player = player;
            const encoder2 = new Encoder(fresh);
            const copy2 = createInstanceFromReflection(fresh, encoder2);
            copy2.decode(encoder2.encodeAll());
            assert.deepStrictEqual(copy2.toJSON(), fresh.toJSON());
            assert.strictEqual(copy2.player.name, "q");
            assert.strictEqual(copy2.player.y, 4);
        });
    });

});
