import * as assert from "assert";
import { State, Player, DeepState, DeepMap, DeepChild, Position, DeepEntity, assertDeepStrictEqualEncodeAll, createInstanceFromReflection, getEncoder } from "./Schema";
import { Schema, ArraySchema, MapSchema, type, Metadata, $changes, Encoder, Decoder, SetSchema } from "../src";

describe("Type: Schema", () => {

    describe("declaration", () => {
        it("default values", () => {
            class DataObject extends Schema {
                @type("string") stringValue = "initial value";
                @type("number") intValue = 300;
            }

            const data = new DataObject();
            assert.strictEqual(data.stringValue, "initial value");
            assert.strictEqual(data.intValue, 300);
            assert.deepStrictEqual(Metadata.getFields(DataObject), {
                stringValue: 'string',
                intValue: 'number',
            });
        });

        it("uint8", () => {
            class Data extends Schema {
                @type("uint8") uint8 = 255;
            }

            let data = new Data();
            assert.strictEqual(data.uint8, 255);

            data.uint8 = 127;

            let encoded = data.encode();
            // assert.deepEqual(encoded, [0, 127]);

            const decoded = new Data();
            decoded.decode(encoded);
            assert.strictEqual(decoded.uint8, 127);
        });

        it("uint16", () => {
            class Data extends Schema {
                @type("uint16") uint16;
            }

            let data = new Data();
            data.uint16 = 65500;

            let encoded = data.encode();
            // assert.deepEqual(encoded, [ 0, 220, 255 ]);

            const decoded = new Data();
            decoded.decode(encoded);
            assert.strictEqual(decoded.uint16, 65500);
        });

        it("uint32", () => {
            class Data extends Schema {
                @type("uint32") uint32;
            }

            let data = new Data();
            data.uint32 = 4294967290;

            let encoded = data.encode();
            // assert.deepEqual(encoded, [0, 250, 255, 255, 255]);

            const decoded = new Data();
            decoded.decode(encoded);
            assert.strictEqual(decoded.uint32, 4294967290);
        });

        it("uint64", () => {
            class Data extends Schema {
                @type("uint64") uint64;
            }

            let data = new Data();
            data.uint64 = Number.MAX_SAFE_INTEGER;

            const encoded = data.encode();
            // assert.deepEqual(encoded, [0, 255, 255, 255, 255, 255, 255, 31, 0]);

            const decoded = new Data();
            decoded.decode(encoded);
            assert.strictEqual(decoded.uint64, Number.MAX_SAFE_INTEGER);
        });

        it("int8", () => {
            class Data extends Schema {
                @type("int8") int8;
            }

            let data = new Data();
            data.int8 = -128;

            let encoded = data.encode();
            // assert.deepEqual(encoded, [0, 128]);

            const decoded = new Data();
            decoded.decode(encoded);
            assert.strictEqual(decoded.int8, -128);
        });

        it("int16", () => {
            class Data extends Schema {
                @type("int16") int16;
            }

            let data = new Data();
            data.int16 = -32768;

            let encoded = data.encode();
            // assert.deepEqual(encoded, []);

            const decoded = new Data();
            decoded.decode(encoded);
            assert.strictEqual(decoded.int16, -32768);
        });

        it("int32", () => {
            class Data extends Schema {
                @type("int32") int32;
            }

            let data = new Data();
            data.int32 = -2147483648;

            let encoded = data.encode();
            // assert.deepEqual(encoded, [0, 4294967290, -1, -1, -1]);

            const decoded = new Data();
            decoded.decode(encoded);
            assert.strictEqual(decoded.int32, -2147483648);
        });

        it("int64", () => {
            class Data extends Schema {
                @type("int64") int64;
            }

            let data = new Data();
            data.int64 = -9223372036854775808;

            const decoded = new Data();
            decoded.decode(data.encode());
            assert.strictEqual(decoded.int64, -9223372036854775808);
        });


        it("float32", () => {
            class Data extends Schema {
                @type("float32") float32;
            }

            let data = new Data();
            data.float32 = 24.5;

            let encoded = data.encode();
            // assert.deepEqual(encoded, [0, 0, 0, 196, 65]);

            const decoded = new Data();
            decoded.decode(encoded);
            assert.strictEqual(decoded.float32, 24.5);
        });

        it("float64", () => {
            class Data extends Schema {
                @type("float64") float64;
            }

            let data = new Data();
            data.float64 = 24.5;

            let encoded = data.encode();

            const decoded = new Data();
            decoded.decode(encoded);
            assert.strictEqual(decoded.float64, 24.5);
        });

        it("varint", () => {
            class Data extends Schema {
                @type("number") varint_minus1 = -1;
                @type("number") varint_int8 = -128;
                @type("number") varint_uint8 = 255;
                @type("number") varint_int16 = -32768;
                @type("number") varint_uint16 = 65535;
                @type("number") varint_int32 = -2147483648;
                @type("number") varint_uint32 = 4294967295;
                @type("number") varint_int64 = -9223372036854775808;
                @type("number") varint_uint64 = Number.MAX_SAFE_INTEGER; // 9007199254740991
                @type("number") varint_float32 = -3.40282347e+38;
                @type("number") varint_float64 = 1.7976931348623157e+308;
            }

            const data = new Data();
            const decoded = new Data();

            const encoded = data.encode();
            decoded.decode(encoded);

            assert.strictEqual(decoded.varint_minus1, -1);
            assert.strictEqual(decoded.varint_int8, -128);
            assert.strictEqual(decoded.varint_uint8, 255);
            assert.strictEqual(decoded.varint_int16, -32768);
            assert.strictEqual(decoded.varint_uint16, 65535);
            assert.strictEqual(decoded.varint_int32, -2147483648);
            assert.strictEqual(decoded.varint_uint32, 4294967295);
            assert.strictEqual(decoded.varint_int64, -9223372036854775808);
            assert.strictEqual(decoded.varint_uint64, Number.MAX_SAFE_INTEGER);
            assert.strictEqual(decoded.varint_float32, -3.40282347e+38);
            assert.strictEqual(decoded.varint_float64, 1.7976931348623157e+308);

            const badByteIndex = encoded.findIndex((byte) => byte < 0 || byte > 255);
            assert.strictEqual(
                -1,
                badByteIndex,
                `invalid byte (${encoded[badByteIndex]}) at index ${badByteIndex}`
            );
        });

        it("boolean", () => {
            class Data extends Schema {
                @type("boolean") bool;
            }

            let data = new Data();
            data.bool = false;

            let encoded = data.encode();

            let decoded = new Data();
            decoded.decode(encoded);
            assert.strictEqual(decoded.bool, false);

            data.bool = true;

            encoded = data.encode();

            decoded.decode(encoded);
            assert.strictEqual(decoded.bool, true);
        });

        it("string", () => {
            class Data extends Schema {
                @type("string") str;
            }

            let data = new Data();
            data.str = "";

            const decoded = new Data();
            decoded.decode(data.encode());
            assert.strictEqual(decoded.str, "");

            data.str = "Hello world!";
            decoded.decode(data.encode());
            assert.strictEqual(decoded.str, "Hello world!");
        });

        it("string with utf8", () => {
            class Data extends Schema {
                @type("string") utf8;
            }

            let data = new Data();
            data.utf8 = "🚀ॐ漢字♤♧♥♢®⚔";

            let encoded = data.encode();
            // assert.deepEqual(encoded, [0, 190, 240, 159, 154, 128, 224, 165, 144, 230, 188, 162, 229, 173, 151, 226, 153, 164, 226, 153, 167, 226, 153, 165, 226, 153, 162, 194, 174, 226, 154, 148]);

            const decoded = new Data();
            decoded.decode(encoded);
            assert.strictEqual(decoded.utf8, "🚀ॐ漢字♤♧♥♢®⚔");
        });

        it("long string", () => {
            class Data extends Schema {
                @type("string") longstring;
            }

            const longstring = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Curabitur ac justo quis massa ultricies dictum cursus at tellus. Curabitur laoreet ipsum eu risus convallis rutrum. Integer bibendum hendrerit nisl, eget vestibulum nisi interdum sed. Pellentesque lacus risus, luctus a iaculis non, vulputate eget massa. Nunc aliquet venenatis lorem, id viverra lectus rutrum a. Nulla nunc mauris, euismod a est nec, scelerisque maximus felis. Sed vel lobortis velit, non congue lectus. In eget lectus at sem bibendum vestibulum in non turpis.";

            let data = new Data();
            data.longstring = longstring;

            const decoded = new Data();
            decoded.decode(data.encode());
            assert.strictEqual(decoded.longstring, longstring);
        });

        it("bigints", () => {
            class Data extends Schema {
                @type("biguint64") u64: bigint;
                @type("bigint64") i64: bigint;
            }

            const buint = BigInt(Number.MAX_SAFE_INTEGER) + 10000n;
            const bint = BigInt(Number.MIN_SAFE_INTEGER) - 10000n;

            let data = new Data();
            data.u64 = buint;
            data.i64 = bint;

            let encoded = data.encode();

            const decoded = new Data();
            decoded.decode(encoded);

            assert.strictEqual(decoded.u64, buint);
            assert.strictEqual(decoded.i64, bint);
        });

        it("manual change tracking", () => {
            class MyState extends Schema {
                @type("string", { manual: true }) currentTurn: string;
            }
            const state = new MyState();
            state.currentTurn = "Hello world!";

            assert.deepStrictEqual([], [...state.encode()], "nothing should be encoded");
            state.setDirty("currentTurn");

            const decodedState = new MyState();
            decodedState.decode(state.encode());

            assert.deepStrictEqual(decodedState.toJSON(), state.toJSON());
        });

        it("should throw an error when defining same property name multiple times", () => {
            class Entity extends Schema {
                @type("string") id: string;
            }

            assert.throws(() => {
                class Player extends Entity {
                    @type("string") id: string;
                }
            }, /Duplicate 'id' definition on 'Player'/);
        });

        it("should allow empty Schema", () => {
            class State extends Schema {}
            const state = new State();
            const encoder = new Encoder(state);
            assert.strictEqual(state, encoder.state);

            const decoder = new Decoder(createInstanceFromReflection(state));
            decoder.decode(encoder.encodeAll());
            assert.deepStrictEqual(decoder.state.toJSON(), encoder.state.toJSON());
        });

        xit("should support TypeScript enums", () => {
            enum Item { SWORD, SHIELD, BOW, POTION }

            class Player extends Schema {
                @type({ set: Item }) items = new SetSchema<Item>();
            }

            class State extends Schema {
                @type({ map: Player }) players = new MapSchema<Player>()
            }

            const state = new State();
            state.players.set("alice", new Player().assign({ items: new SetSchema<Item>([Item.SWORD, Item.SHIELD]) }));
            state.players.set("bob", new Player().assign({ items: new SetSchema<Item>([Item.BOW, Item.POTION]) }));

            const decodedState = new State();
            decodedState.decode(state.encode());

            assert.strictEqual(2, decodedState.players.size);
            assertDeepStrictEqualEncodeAll(state);
        });

        it("number should be able to encode Date.now()", () => {
            class State extends Schema {
                @type("number") timestamp: number = Date.now();
            }
            const state = new State();
            const decodedState = createInstanceFromReflection(state);
            decodedState.decode(state.encode());
            assert.strictEqual(state.timestamp, decodedState.timestamp);
        });

        it("xxxxxx", () => {
            class Player extends Schema {
                @type("number") health: number = 100;
            }

            class GameState extends Schema {
                @type({ map: Player }) players = new MapSchema<Player>();
                @type("number") round: number = 1;
            }

            function generateId() {
                return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
            }

            const state = new GameState();
            const encoder = getEncoder(state);

            function simulateJoin(id = generateId()) {
                const player = new Player();
                state.players.set(id, player);

                const decoded = createInstanceFromReflection(state);
                decoded.decode(state.encodeAll());

                decoded.decode(state.encode());
                state.players.delete(id);
            }

            for (let i = 0; i < 3; i++) {
                simulateJoin();
            }

        });

    });

    describe("detecting changes", () => {
        it("Schema", () => {
            const state = new State();
            assert.strictEqual(false, state[$changes].changed);

            state.fieldNumber = 10;
            assert.strictEqual(true, state[$changes].changed);

            state.player = new Player().assign({ name: "Hello" });
            assert.strictEqual(true, state[$changes].changed);

            state.discardAllChanges();
            assert.strictEqual(false, state[$changes].changed);

            state.player.name = "Changed...";
            assert.strictEqual(true, state.player[$changes].changed);
        });

        it("MapSchema", () => {
            const state = new State();
            state.mapOfPlayers = new MapSchema<Player>();
            state.mapOfPlayers.set('one', new Player().assign({ name: "One" }));

            state.discardAllChanges();
            assert.strictEqual(false, state[$changes].changed);

            state.mapOfPlayers.get('one').name = "Changed...";
            assert.strictEqual(true, state.mapOfPlayers.get('one')[$changes].changed);
        });
    })

    describe("API", () => {
        it("should allow deleting non-existing items", () => {
            assert.doesNotThrow(() => {
                const state = new State();
                state.mapOfPlayers = new MapSchema<Player>();
                state.mapOfPlayers.delete('jake')
            });
        });

        it("should allow to clone Schema instances", () => {
            const CONSTANT_PLAYER = new Player("Cloned", 100, 100);
            const state = new State();
            state.player = CONSTANT_PLAYER.clone();
            state.mapOfPlayers = new MapSchema<Player>();
            state.mapOfPlayers.set('one', CONSTANT_PLAYER.clone());
            state.arrayOfPlayers = new ArraySchema<Player>();
            state.arrayOfPlayers.push(CONSTANT_PLAYER.clone());

            const decodedState = new State();
            decodedState.decode(state.encode());
            assert.strictEqual(decodedState.player.name, "Cloned");
            assert.strictEqual(decodedState.mapOfPlayers.get('one').name, "Cloned");
            assert.strictEqual(decodedState.arrayOfPlayers[0].name, "Cloned");
        });

        it("should allow to .assign() with null and undefined", () => {
            const CONSTANT_PLAYER = new Player("Cloned", 100, 100);
            const state1 = new State();
            state1.player = CONSTANT_PLAYER.clone();
            state1.mapOfPlayers = new MapSchema<Player>();
            state1.mapOfPlayers.set('one', CONSTANT_PLAYER.clone());
            state1.arrayOfPlayers = new ArraySchema<Player>();
            state1.arrayOfPlayers.push(CONSTANT_PLAYER.clone());
            assertDeepStrictEqualEncodeAll(state1);
            state1.assign({ player: null, mapOfPlayers: null, arrayOfPlayers: null, });
            assertDeepStrictEqualEncodeAll(state1);

            const state2 = new State();
            state2.player = CONSTANT_PLAYER.clone();
            state2.mapOfPlayers = new MapSchema<Player>();
            state2.mapOfPlayers.set('one', CONSTANT_PLAYER.clone());
            state2.arrayOfPlayers = new ArraySchema<Player>();
            state2.arrayOfPlayers.push(CONSTANT_PLAYER.clone());
            assertDeepStrictEqualEncodeAll(state2);
            state2.assign({ player: undefined, mapOfPlayers: undefined, arrayOfPlayers: undefined, });
            assertDeepStrictEqualEncodeAll(state2);
        });

        it("should support Object.assign() on constructor", () => {
            class Player extends Schema {
                constructor(data: Partial<Player>) {
                    super();
                    Object.assign(this, data);
                }
                @type("string") str: string;
                @type("number") num: number;
            }
            class State extends Schema {
                @type({map: Player}) players = new MapSchema<Player>();
            }

            const state = new State();
            state.players.set("one", new Player({ str: "Hello", num: 123 }));

            const decodedState = createInstanceFromReflection(state);
            decodedState.decode(state.encode());

            assert.deepStrictEqual({ players: { one: { str: 'Hello', num: 123 } } }, decodedState.toJSON());
        });
    });

    describe("encoding/decoding", () => {
        it("should encode/decode STRING", () => {
            const state = new State();
            state.fieldString = "Hello world";

            let encoded = state.encode();
            // assert.deepEqual(encoded, [0, 171, 72, 101, 108, 108, 111, 32, 119, 111, 114, 108, 100]);

            const decodedState = new State();
            decodedState.decode(encoded);

            assert.strictEqual(decodedState.fieldString, "Hello world");
        });

        it("should encode/decode INT", () => {
            const state = new State();
            state.fieldNumber = 50;

            const decodedState = new State();

            let encoded = state.encode();
            // assert.deepEqual(encoded, [1, 50]);

            decodedState.decode(encoded);

            assert.strictEqual(decodedState.fieldNumber, 50);

            state.fieldNumber = 100;
            decodedState.decode(state.encode());
            assert.strictEqual(decodedState.fieldNumber, 100);

            state.fieldNumber = 300;
            decodedState.decode(state.encode());
            assert.strictEqual(decodedState.fieldNumber, 300);

            state.fieldNumber = 500;
            decodedState.decode(state.encode());
            assert.strictEqual(decodedState.fieldNumber, 500);

            state.fieldNumber = 1000;
            decodedState.decode(state.encode());
            assert.strictEqual(decodedState.fieldNumber, 1000);

            state.fieldNumber = 2000;
            decodedState.decode(state.encode());
            assert.strictEqual(decodedState.fieldNumber, 2000);

            state.fieldNumber = 999999;
            decodedState.decode(state.encode());
            assert.strictEqual(decodedState.fieldNumber, 999999);
        });

        it("should encode/decode empty Schema reference", () => {
            const state = new State();
            state.player = new Player();

            const decodedState = new State();
            const encoded = state.encode();
            decodedState.decode(encoded);

            // assert.deepEqual(encoded, [2, 193]);
            assert.ok(decodedState.player instanceof Player);
        });

        it("should allow to delete Schema reference", () => {
            const state = new State();
            state.player = new Player();

            const decodedState = new State();
            const encoded = state.encode();
            decodedState.decode(encoded);

            state.player = undefined;
            decodedState.decode(state.encode());

            assert.strictEqual(decodedState.player, undefined);
        });

        it("should encode/decode Schema reference with its properties", () => {
            const state = new State();
            state.player = new Player();
            state.player.name = "Jake";
            state.player.x = 100;
            state.player.y = 200;

            const decodedState = new State();
            const encoded = state.encode();
            decodedState.decode(encoded);

            // assert.deepEqual(encoded, [2, 0, 164, 74, 97, 107, 101, 1, 100, 2, 204, 200, 193]);
            assert.ok(decodedState.player instanceof Player);
            assert.strictEqual(decodedState.player.x, 100);
            assert.strictEqual(decodedState.player.y, 200);
        });

        it("should re-use child Schema instance when decoding multiple times", () => {
            const state = new State();
            state.player = new Player();
            state.player.name = "Guest";

            const decodedState = new State();
            decodedState.decode(state.encode());

            const playerReference = decodedState.player;
            assert.ok(playerReference instanceof Player);
            assert.strictEqual(playerReference.name, "Guest");

            state.player.name = "Jake";
            decodedState.decode(state.encode());
            assert.strictEqual(decodedState.player, playerReference);
            assert.strictEqual(playerReference.name, "Jake");
        });

        it("should encode empty array", () => {
            const state = new State();
            state.arrayOfPlayers = new ArraySchema();

            const decodedState = new State();
            const encoded = state.encode();
            decodedState.decode(encoded);

            // assert.deepEqual(encoded, [3, 0, 0]);
            assert.deepEqual(decodedState.arrayOfPlayers.toJSON(), []);
        });

        it("should encode map of objects", () => {
            const state = new State();
            state.mapOfPlayers = new MapSchema({
                "one": new Player("Jake Badlands"),
                "two": new Player("Snake Sanders")
            });

            let encoded = state.encode();
            // assert.deepEqual(encoded, [4, 2, 163, 111, 110, 101, 0, 173, 74, 97, 107, 101, 32, 66, 97, 100, 108, 97, 110, 100, 115, 193, 163, 116, 119, 111, 0, 173, 83, 110, 97, 107, 101, 32, 83, 97, 110, 100, 101, 114, 115, 193]);

            const decodedState = new State();
            decodedState.decode(encoded);

            const playerOne = decodedState.mapOfPlayers.get('one');
            const playerTwo = decodedState.mapOfPlayers.get('two');

            assert.deepStrictEqual(Array.from(decodedState.mapOfPlayers.keys()), ["one", "two"]);
            assert.strictEqual(playerOne.name, "Jake Badlands");
            assert.strictEqual(playerTwo.name, "Snake Sanders");

            state.mapOfPlayers.get('one').name = "Tarquinn";

            encoded = state.encode();
            // assert.deepEqual(encoded, [4, 1, 0, 0, 168, 84, 97, 114, 113, 117, 105, 110, 110, 193]);

            decodedState.decode(encoded);

            assert.strictEqual(playerOne, decodedState.mapOfPlayers.get('one'));
            assert.strictEqual(decodedState.mapOfPlayers.get('one').name, "Tarquinn");
        });

        it("should allow adding and removing items from map", () => {
            const state = new State();
            state.mapOfPlayers = new MapSchema();

            state.mapOfPlayers.set('one', new Player("Jake Badlands"));
            state.mapOfPlayers.set('two', new Player("Snake Sanders"));

            const decodedState = new State();
            decodedState.decode(state.encode());

            assert.deepStrictEqual(Array.from(decodedState.mapOfPlayers.keys()), ["one", "two"]);
            assert.strictEqual(decodedState.mapOfPlayers.get('one').name, "Jake Badlands");
            assert.strictEqual(decodedState.mapOfPlayers.get('two').name, "Snake Sanders");

            state.mapOfPlayers.delete('two');
            decodedState.decode(state.encode());
            assert.deepStrictEqual(Array.from(decodedState.mapOfPlayers.keys()), ["one"]);
        });

        it("should allow moving items from one map key to another", () => {
            const state = new State();
            state.mapOfPlayers = new MapSchema();

            state.mapOfPlayers.set('one', new Player("Jake Badlands"));
            state.mapOfPlayers.set('two', new Player("Snake Sanders"));

            const decodedState = new State();
            decodedState.decode(state.encode());

            const decodedJake = decodedState.mapOfPlayers.get('one');
            const decodedSnake = decodedState.mapOfPlayers.get('two');
            assert.deepStrictEqual(Array.from(decodedState.mapOfPlayers.keys()), ["one", "two"]);

            // swap Jake / Snake keys
            const jake = state.mapOfPlayers.get('one');
            const snake = state.mapOfPlayers.get('two');
            state.mapOfPlayers.set('one', snake);
            state.mapOfPlayers.set('two', jake);

            decodedState.decode(state.encode());

            assert.deepStrictEqual(decodedState.mapOfPlayers.get('one'), decodedSnake);
            assert.deepStrictEqual(decodedState.mapOfPlayers.get('two'), decodedJake);

            assert.deepStrictEqual(state.toJSON(), decodedState.toJSON());
        });

        it("should allow maps with numeric indexes", () => {
            const state = new State();
            state.mapOfPlayers = new MapSchema({
                '2': new Player("Jake Badlands"),
                '1': new Player("Snake Sanders")
            });

            const decodedState = new State();
            decodedState.decode(state.encodeAll());

            assert.deepEqual(Array.from(decodedState.mapOfPlayers.keys()), ['1', '2']);
            assert.strictEqual(decodedState.mapOfPlayers.get('1').name, "Snake Sanders");
            assert.strictEqual(decodedState.mapOfPlayers.get('2').name, "Jake Badlands");

            state.mapOfPlayers.get('1').name = "New name";
            decodedState.decode(state.encodeAll());

            assert.deepEqual(decodedState.mapOfPlayers.get('1').name, "New name");
            assert.deepEqual(decodedState.mapOfPlayers.get('2').name, "Jake Badlands");
        });

        it("should encode changed values", () => {
            const state = new State();
            state.fieldString = "Hello world!";
            state.fieldNumber = 50;

            state.player = new Player();
            state.player.name = "Jake Badlands";
            state.player.y = 50;

            const encoded = state.encode();
            // assert.deepEqual(encoded, [0, 172, 72, 101, 108, 108, 111, 32, 119, 111, 114, 108, 100, 33, 1, 50, 2, 0, 173, 74, 97, 107, 101, 32, 66, 97, 100, 108, 97, 110, 100, 115, 2, 50, 193]);

            // SHOULD PRESERVE VALUES AFTER SERIALIZING
            assert.strictEqual(state.fieldString, "Hello world!");
            assert.strictEqual(state.fieldNumber, 50);
            assert.ok(state.player instanceof Player);
            assert.strictEqual(state.player[$changes].parent, state);
            assert.strictEqual(state.player.name, "Jake Badlands");
            assert.strictEqual(state.player.x, undefined);
            assert.strictEqual(state.player.y, 50);

            const decodedState = new State();
            decodedState.decode(encoded);

            const decodedPlayerReference = decodedState.player;

            assert.strictEqual(decodedState.fieldString, "Hello world!");
            assert.strictEqual(decodedState.fieldNumber, 50);

            assert.ok(decodedPlayerReference instanceof Player);
            assert.strictEqual(decodedState.player.name, "Jake Badlands");
            assert.strictEqual(decodedState.player.x, undefined, "unset variable should be undefined");
            assert.strictEqual(decodedState.player.y, 50);

            /**
             * Lets encode a single change now
             */

            // are Player and State unchanged?
            assert.strictEqual(state.player[$changes].changed, false);
            assert.strictEqual(state[$changes].changed, false);

            state.player.x = 30;

            // Player and State should've changes!
            assert.strictEqual(state.player[$changes].changed, true);
            // assert.strictEqual(state['$changes'].changed, true);

            const serializedChanges = state.encode();

            decodedState.decode(serializedChanges);
            assert.strictEqual(decodedPlayerReference, decodedState.player, "should re-use the same Player instance");
            assert.strictEqual(decodedState.player.name, "Jake Badlands");
            assert.strictEqual(decodedState.player.x, 30);
            assert.strictEqual(decodedState.player.y, 50);
        });

        it("should support array of strings", () => {
            class MyState extends Schema {
                @type(["string"])
                arrayOfStrings: ArraySchema<string>;
            }

            const state = new MyState();
            state.arrayOfStrings = new ArraySchema("one", "two", "three");

            let encoded = state.encode();
            // assert.deepEqual(encoded, [0, 3, 3, 0, 163, 111, 110, 101, 1, 163, 116, 119, 111, 2, 165, 116, 104, 114, 101, 101]);

            const decodedState = new MyState();
            decodedState.decode(encoded);
            assert.deepEqual(decodedState.arrayOfStrings.toArray(), ["one", "two", "three"]);

            // mutate array
            state.arrayOfStrings.push("four")
            encoded = state.encode();
            // assert.deepEqual(encoded, [ 0, 4, 1, 3, 164, 102, 111, 117, 114 ]);

            decodedState.decode(encoded);
            assert.deepEqual(decodedState.arrayOfStrings.toArray(), ["one", "two", "three", "four"]);
        });

        it("should support array of numbers", () => {
            class MyState extends Schema {
                @type(["number"])
                arrayOfNumbers: ArraySchema<number>;
            }

            const state = new MyState();
            state.arrayOfNumbers = new ArraySchema(0, 144, 233, 377, 610, 987, 1597, 2584);

            let encoded = state.encode();
            // assert.deepEqual(encoded, [0, 8, 8, 0, 0, 1, 204, 144, 2, 204, 233, 3, 205, 121, 1, 4, 205, 98, 2, 5, 205, 219, 3, 6, 205, 61, 6, 7, 205, 24, 10]);

            const decodedState = new MyState();
            decodedState.decode(encoded);

            assert.deepEqual(decodedState.arrayOfNumbers.toArray(), [0, 144, 233, 377, 610, 987, 1597, 2584]);

            // mutate array
            state.arrayOfNumbers.push(999999);
            encoded = state.encode();
            // assert.deepEqual(encoded, [0, 9, 1, 8, 206, 63, 66, 15, 0]);

            decodedState.decode(encoded);
            assert.deepEqual(decodedState.arrayOfNumbers.toArray(), [0, 144, 233, 377, 610, 987, 1597, 2584, 999999]);
        });

        it("should support map of numbers", () => {
            class MyState extends Schema {
                @type({ map: "number" }) mapOfNumbers: MapSchema<number>;
            }

            const state = new MyState();
            state.mapOfNumbers = new MapSchema<number>({ 'zero': 0, 'one': 1, 'two': 2 });

            let encoded = state.encode();
            // assert.deepEqual(encoded, []);

            const decodedState = new MyState();
            decodedState.decode(encoded);
            assert.deepStrictEqual(decodedState.mapOfNumbers.toJSON(), { 'zero': 0, 'one': 1, 'two': 2 });

            // mutate map
            state.mapOfNumbers.set('three', 3);
            encoded = state.encode();
            // assert.deepEqual(encoded, []);

            decodedState.decode(encoded);
            assert.deepStrictEqual(decodedState.mapOfNumbers.toJSON(), { 'zero': 0, 'one': 1, 'two': 2, 'three': 3 });
        });

        describe("no changes", () => {
            it("empty state", () => {
                const state = new State();

                // TODO: ideally this should be 0
                assert.ok(state.encode().length <= 2);

                const decodedState = new State();
                assert.doesNotThrow(() => decodedState.decode(state.encode()));

                state.arrayOfPlayers = new ArraySchema();
                state.mapOfPlayers = new MapSchema();
                assert.doesNotThrow(() => decodedState.decode(state.encode()));
            });

            it("updating with same value", () => {
                const state = new State();
                state.mapOfPlayers = new MapSchema<Player>({
                    jake: new Player("Jake Badlands", 50, 50)
                });
                assert.ok(state.encode().length > 0);

                state.mapOfPlayers.get('jake').x = 50;
                state.mapOfPlayers.get('jake').y = 50;

                assert.strictEqual(0, state.encode().length, "updates with same value shouldn't trigger change.");
            });
        });
    });

    describe("limitations", () => {
        it("should DELETE a null string", () => {
            class MyState extends Schema {
                @type("string")
                myString: string = "hello";
            };

            const state = new MyState();
            const decodedState = new MyState();
            decodedState.decode(state.encodeAll());

            assert.strictEqual(decodedState.myString, "hello");

            state.myString = undefined;
            decodedState.decode(state.encode());
            assert.strictEqual(decodedState.myString, undefined);

            assert.throws(() => {
                // @ts-ignore
                state.myString = {};
                decodedState.decode(state.encode());
            }, /a 'string' was expected/ig);

            class AToStringClass {
                toJSON (){ return "I'm a json!"; }
                toString () { return "I'm not a string!"; }
            }
            assert.throws(() => {
                (state as any).myString = new AToStringClass();
                decodedState.decode(state.encode());
            }, /a 'string' was expected, but '"I'm a json!"' \(AToStringClass\) was provided./ig);
        });

        it("number maximum and minimum values", () => {
            class MyState extends Schema {
                @type("number") myNumber: number = 1;
                @type("uint8") uint8: number = 50;
            };

            const state = new MyState();
            const decodedState = new MyState();
            decodedState.decode(state.encodeAll());

            assert.strictEqual(decodedState.myNumber, 1);

            state.myNumber = null;
            decodedState.decode(state.encode());
            assert.strictEqual(decodedState.myNumber, undefined);

            state.myNumber = Infinity;
            decodedState.decode(state.encode());
            assert.strictEqual(decodedState.myNumber, Number.MAX_SAFE_INTEGER);

            state.myNumber = -Infinity;
            decodedState.decode(state.encode());
            assert.strictEqual(decodedState.myNumber, -Number.MAX_SAFE_INTEGER);

            state.myNumber = NaN;
            decodedState.decode(state.encode());
            assert.strictEqual(decodedState.myNumber, 0);

            state.uint8 = null;
            decodedState.decode(state.encode());
            assert.strictEqual(decodedState.uint8, undefined);

            assert.throws(() => {
                (state as any).myNumber = {};
                decodedState.decode(state.encode());
            }, /a 'number' was expected/ig);
        });

        it("should trigger error when assigning incompatible Schema type", () => {
            class Entity extends Schema {
                @type("number") x: number;
                @type("number") y: number;
            }

            class Player extends Entity {
                @type("string") name: string;
            }

            class MyState extends Schema {
                @type(Player) player = new Player();
                @type(Entity) entity = new Entity();
                @type([Player]) arrayOfPlayers = new ArraySchema<Player>();
                @type({ map: Player }) mapOfPlayers = new MapSchema<Player>();
            }

            assert.throws(() => {
                const state = new MyState();
                (state as any).player = {};
                state.encode();
            }, /a 'player' was expected/ig);

            assert.throws(() => {
                const state = new MyState();
                state.arrayOfPlayers.push({} as Player);
                state.encode();
            }, /a 'player' was expected/ig);

            assert.throws(() => {
                const state = new MyState();
                // @ts-ignore
                state.mapOfPlayers.set('one', new Entity());
                state.encode();
            }, /a 'player' was expected/ig);

            assert.throws(() => {
                const state = new MyState();
                // @ts-ignore
                state.mapOfPlayers.set('one', {});
                state.encode();
            }, /a 'player' was expected/ig);

            assert.throws(() => {
                const state = new MyState();
                (state as any).player = new Entity();
                state.encode();
            }, /a 'player' was expected/ig);

            assert.throws(() => {
                const state = new MyState();
                (state as any).player = new Entity().assign({ x: 0, y: 0 });
                state.encode();
            }, /a 'Player' was expected, but 'Entity' was provided/ig);

            assert.doesNotThrow(() => {
                const state = new MyState();
                state.entity = new Player().assign({ name: "Player name", x: 50, y: 50 });
                state.encode();
            });

            const state = new MyState();
            (state as any).player = new Player().assign({ name: "Name", x: 100, y: 100 });

            const decodedState = new MyState();
            decodedState.decode(state.encodeAll());
            assert.strictEqual(decodedState.player.name, "Name");
            assert.strictEqual(decodedState.player.x, 100);
            assert.strictEqual(decodedState.player.y, 100);
        });

        it("should transform plain array into ArraySchema", () => {
            class MyState extends Schema {
                @type([ "string" ]) array = new ArraySchema<string>();
            }

            const state = new MyState();
            state.array = ["hello"] as ArraySchema;
            assert.ok(state.array instanceof ArraySchema);

            const decoded = new MyState();
            decoded.decode(state.encode());
            assert.deepEqual(["hello"], decoded.array.toArray());
        });

        it("should transform plain map into MapSchema", () => {
            class MyState extends Schema {
                @type({ map: "string" }) map = new MapSchema<string>();
            }

            const state = new MyState();
            (state as any).map = { one: "hello" };
            assert.ok(state.map instanceof MapSchema);

            const decoded = new MyState();
            decoded.decode(state.encode());
            assert.deepEqual({one: "hello"}, decoded.map.toJSON());
        });
    })

    describe("encoder: encodeAll", () => {
        it('should encode everything again', () => {
            const state = new State();

            state.mapOfPlayers = new MapSchema<Player>();
            state.mapOfPlayers.set('jake', new Player("Jake"));
            state.mapOfPlayers.set('katarina', new Player("Jake"));
            state.encodeAll();

            const decodedState = new State();
            decodedState.decode(state.encode());
            assert.deepEqual(Array.from(decodedState.mapOfPlayers.keys()), ['jake', 'katarina']);

            let jakeX = Math.random() * 2000;
            state.mapOfPlayers.get('jake').x = jakeX;
            decodedState.decode(state.encode());
            assert.strictEqual(decodedState.mapOfPlayers.get('jake').x.toFixed(3), jakeX.toFixed(3));

            state.mapOfPlayers.delete('jake');
        });

        //
        // Encoding from a decoded structure is not supported
        //
        // This is not a real usage scenario yet, but on a peer-to-peer setup
        // this feature would play an interesting role.
        //
        it.skip('should encode map with primitive values from decoded state', () => {
            class TestMapSchema extends Schema {
                @type({ map: 'number' }) value = new MapSchema<number>();
            }

            const state = new TestMapSchema();
            state.value.set('k1', 1);

            const firstEncoded = state.encodeAll();

            const decodedState1 = new TestMapSchema();
            decodedState1.decode(firstEncoded);
            assert.deepStrictEqual(decodedState1.toJSON(), state.toJSON());

            const secondEncoded = decodedState1.encodeAll();
            assert.deepStrictEqual(secondEncoded, firstEncoded);

            const decodedState2 = new TestMapSchema();
            decodedState2.decode(secondEncoded);
            assert.deepStrictEqual(decodedState2.toJSON(), state.toJSON());
        });

        it('should discard deleted map items', () => {
            class Player extends Schema {
                @type("number") xp: number;
            }
            class MyState extends Schema {
                @type({ map: Player }) players = new MapSchema<Player>();
                @type("number") n = 100;
            }

            const state = new MyState();
            state.players.set('one', new Player().assign({ xp: 100 }));
            state.players.set('two', new Player().assign({ xp: 100 }));

            const decodedState1 = new MyState();
            decodedState1.decode(state.encodeAll());
            assert.deepStrictEqual(Array.from(decodedState1.players.keys()), ['one', 'two']);
            assert.strictEqual(decodedState1.n, 100);

            state.players.delete('two');

            const decodedState2 = new MyState();
            decodedState2.decode(state.encodeAll());
            assert.deepStrictEqual(Array.from(decodedState2.players.keys()), ['one']);
            assert.strictEqual(decodedState2.n, 100);
        });

        it("should decode a child structure alone (Schema encoded messages)", () => {
            const state = new State();

            state.mapOfPlayers = new MapSchema<Player>();
            state.mapOfPlayers.set('jake', new Player("Jake"));
            state.mapOfPlayers.set('katarina', new Player("Jake"));
            state.encode();

            const decodedPlayer = new Player();
            decodedPlayer.decode(state.mapOfPlayers.get('jake').encodeAll());
            assert.strictEqual("Jake", decodedPlayer.name);
        });
    });


    describe("deep structures / re-assignents", () => {
        it("should allow re-assigning child schema type", () => {
            const state = new DeepState();
            const deepMap = new DeepMap();

            const deepChild = new DeepChild();
            deepChild.entity.name = "Player one";
            deepChild.entity.another.position = new Position(100, 200, 300);
            deepMap.arrayOfChildren.push(deepChild);

            state.map.set('one', deepMap);

            const decodedState = new DeepState();
            decodedState.decode(state.encodeAll());

            assert.strictEqual(decodedState.map.get('one').arrayOfChildren[0].entity.name, "Player one");
            assert.strictEqual(decodedState.map.get('one').arrayOfChildren[0].entity.another.position.x, 100);
            assert.strictEqual(decodedState.map.get('one').arrayOfChildren[0].entity.another.position.y, 200);
            assert.strictEqual(decodedState.map.get('one').arrayOfChildren[0].entity.another.position.z, 300);


            const decodedState2 = new DeepState();
            decodedState2.decode(state.encodeAll());
            assert.strictEqual(decodedState2.map.get('one').arrayOfChildren[0].entity.name, "Player one");
            assert.strictEqual(decodedState2.map.get('one').arrayOfChildren[0].entity.another.position.x, 100);
            assert.strictEqual(decodedState2.map.get('one').arrayOfChildren[0].entity.another.position.y, 200);
            assert.strictEqual(decodedState2.map.get('one').arrayOfChildren[0].entity.another.position.z, 300);

            assertDeepStrictEqualEncodeAll(state);
        });
    });

    describe("Inheritance", () => {
        it("should support inherited root type", () => {
            class BaseState extends Schema {
                @type("string") str: string;
                @type("number") num: number;
            }

            class State extends BaseState {
                @type("boolean") bool: boolean;
            }

            const state = new State();
            state.str = "Hello world";
            state.num = 100;
            state.bool = true;

            assert.deepStrictEqual(state.toJSON(), { str: 'Hello world', num: 100, bool: true });

            const decodedState = createInstanceFromReflection(state);
            decodedState.decode(state.encode());

            assert.deepStrictEqual(decodedState.toJSON(), { str: 'Hello world', num: 100, bool: true });
            assertDeepStrictEqualEncodeAll(state);
        });

        it("using direct Schema -> Schema reference", () => {
            class Action extends Schema {
                @type("boolean") active: boolean;
            }
            class BattleAction extends Action {
                @type("number") damage: number;
            }
            class MoveAction extends Action {
                @type("string") targetTile: string;
                @type("number") speed: number;
            }
            class State extends Schema {
                @type(Action) action: Action;
            }

            const state = new State();
            state.action = new Action().assign({ active: false });

            const decodedState = new State();
            decodedState.decode(state.encode());

            assert.strictEqual(false, decodedState.action.active);

            state.action.active = true;
            decodedState.decode(state.encode());
            assert.strictEqual(true, decodedState.action.active);

            state.action = new BattleAction().assign({ active: false, damage: 100 });
            decodedState.decode(state.encode());
            assert.strictEqual(false, decodedState.action.active);
            assert.strictEqual(100, (decodedState.action as BattleAction).damage);

            state.action.active = true;
            decodedState.decode(state.encode());
            assert.strictEqual(true, decodedState.action.active);

            assertDeepStrictEqualEncodeAll(state);
        })
    });

    describe("clone()", () => {
        it("should allow to clone deep structures", () => {
            const state = new DeepState();
            state.map.set('one', new DeepMap());

            const deepChild = new DeepChild();
            deepChild.entity.name = "Player one";
            deepChild.entity.another.position = new Position(100, 200, 300);
            state.map.get('one').arrayOfChildren.push(deepChild);

            const decodedState = new DeepState();
            decodedState.decode(state.encodeAll());

            state.map.set('two', state.map.get('one').clone());
            state.map.get('two').arrayOfChildren[0].entity.name = "Player two";
            state.map.get('two').arrayOfChildren[0].entity.another.position.x = 200;
            state.map.get('two').arrayOfChildren[0].entity.another.position.y = 300;
            state.map.get('two').arrayOfChildren[0].entity.another.position.z = 400;

            decodedState.decode(state.encode());

            assert.strictEqual(decodedState.map.get('one').arrayOfChildren[0].entity.name, "Player one");
            assert.strictEqual(decodedState.map.get('one').arrayOfChildren[0].entity.another.position.x, 100);
            assert.strictEqual(decodedState.map.get('one').arrayOfChildren[0].entity.another.position.y, 200);
            assert.strictEqual(decodedState.map.get('one').arrayOfChildren[0].entity.another.position.z, 300);

            assert.strictEqual(decodedState.map.get('two').arrayOfChildren[0].entity.name, "Player two");
            assert.strictEqual(decodedState.map.get('two').arrayOfChildren[0].entity.another.position.x, 200);
            assert.strictEqual(decodedState.map.get('two').arrayOfChildren[0].entity.another.position.y, 300);
            assert.strictEqual(decodedState.map.get('two').arrayOfChildren[0].entity.another.position.z, 400);

            assert.deepStrictEqual(state.toJSON(), state.clone().toJSON());

            assertDeepStrictEqualEncodeAll(state);
        });
    });

    describe("toJSON()", () => {
        it("should return child structures as JSON", () => {
            const state = new State();
            state.fieldString = "string";
            state.fieldNumber = 10;

            state.player = new Player();
            state.player.name = "Jake";
            state.player.x = 10;

            state.mapOfPlayers = new MapSchema();
            state.mapOfPlayers.set('one', new Player().assign({ name: "Cyberhalk", x: 100, y: 50 }));

            state.arrayOfPlayers = new ArraySchema();
            state.arrayOfPlayers.push(new Player("Katarina"))

            assert.deepStrictEqual(state.toJSON(), {
                fieldString: 'string',
                fieldNumber: 10,
                player: { name: 'Jake', x: 10 },
                arrayOfPlayers: [{ name: 'Katarina' }],
                mapOfPlayers: { one: { name: 'Cyberhalk', x: 100, y: 50 } }
            })

            assertDeepStrictEqualEncodeAll(state);
        });

        it("should be able to re-construct entire schema tree", () => {
            const state = new State();
            state.fieldNumber = 10;
            state.fieldString = "Hello world";

            state.mapOfPlayers = new MapSchema<Player>();
            state.mapOfPlayers.set('one', new Player().assign({ name: "Player one", x: 1, y: 1 }));
            state.mapOfPlayers.set('two', new Player().assign({ name: "Player two", x: 2, y: 2 }));

            state.arrayOfPlayers = new ArraySchema<Player>();
            state.arrayOfPlayers.push(new Player().assign({name: "One"}));
            state.arrayOfPlayers.push(new Player().assign({name: "Two"}));

            state.player = new Player().assign({ name: "A player", x: 0, y: 0 });

            const newState = new State().assign(state);
            assert.deepStrictEqual(state.toJSON(), newState.toJSON());

            assertDeepStrictEqualEncodeAll(state);
        });
    });

    describe("move and nullify previous", () => {
        it("using MapSchema", () => {
            class State extends Schema {
                @type({ map: "number" }) previous: MapSchema<number>;
                @type({ map: "number" }) current: MapSchema<number>;
            }

            const state = new State();
            const decodedState = new State();

            state.current = new MapSchema<number>();
            state.current.set("0", 0);

            decodedState.decode(state.encode());
            assert.strictEqual(0, decodedState.current.get("0"));
            assert.strictEqual(undefined, decodedState.previous);

            [state.current, state.previous] = [null, state.current];
            // state.previous = state.current;
            // state.current = null;

            assert.doesNotThrow(() => decodedState.decode(state.encode()));
            assert.strictEqual(0, decodedState.previous.get("0"));
            assert.strictEqual(undefined, decodedState.current);

            assertDeepStrictEqualEncodeAll(state);
        });

        it("using ArraySchema", () => {
            class State extends Schema {
                @type(["number"]) previous: ArraySchema<number>;
                @type(["number"]) current: ArraySchema<number>;
            }

            const state = new State();
            const decodedState = new State();

            state.current = new ArraySchema<number>();
            state.current[0] = 0;

            decodedState.decode(state.encode());
            assert.strictEqual(0, decodedState.current[0]);
            assert.strictEqual(undefined, decodedState.previous);

            [state.current, state.previous] = [null, state.current];
            // state.previous = state.current;
            // state.current = null;

            assert.doesNotThrow(() => decodedState.decode(state.encode()));
            assert.strictEqual(0, decodedState.previous[0]);
            assert.strictEqual(undefined, decodedState.current);

            assertDeepStrictEqualEncodeAll(state);
        });

        it("using Schema reference", () => {
            class Player extends Schema {
                @type("string") str: string;
            }
            class State extends Schema {
                @type(Player) previous: Player;
                @type(Player) current: Player;
            }

            const state = new State();
            const decodedState = new State();

            state.current = new Player().assign({ str: "hey" });
            decodedState.decode(state.encode());
            assert.strictEqual("hey", decodedState.current.str);
            assert.strictEqual(undefined, decodedState.previous);

            [state.current, state.previous] = [null, state.current];
            // state.previous = state.current;
            // state.current = null;

            assert.doesNotThrow(() => decodedState.decode(state.encode()));
            assert.strictEqual("hey", decodedState.previous.str);
            assert.strictEqual(undefined, decodedState.current);

            assertDeepStrictEqualEncodeAll(state);
        });
    });

});
