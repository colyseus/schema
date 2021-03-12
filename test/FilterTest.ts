import * as assert from "assert";
import * as util from "util";
import * as sinon from "sinon";
import { Schema, type, filter, ArraySchema, MapSchema, Reflection, DataChange } from "../src";
import { ClientWithSessionId, filterChildren } from "../src/annotations";
import { nanoid } from "nanoid";
import { assertExecutionTime } from "./helpers/test_helpers";


describe("@filter Test", () => {

    it("should filter property outside root", () => {
        class Player extends Schema {
            @filter(function(this: Player, client: ClientWithSessionId, value, root: State) {
                return (
                    (root.playerOne === this && client.sessionId === "one") ||
                    (root.playerTwo === this && client.sessionId === "two")
                );
            })
            @type("string") name: string;
        }

        class State extends Schema {
            @type(Player) playerOne: Player;
            @type(Player) playerTwo: Player;
        }

        const state = new State();
        state.playerOne = new Player();
        state.playerOne.name = "Jake";

        state.playerTwo = new Player();
        state.playerTwo.name = "Katarina";

        const encoded = state.encode(undefined, undefined, true);

        const full = new State();
        full.decode(encoded);

        const client1 = { sessionId: "one" };
        const client2 = { sessionId: "two" };

        const filtered1 = state.applyFilters(client1);
        const decoded1 = new State();
        decoded1.decode(filtered1);

        const filtered2 = state.applyFilters(client2);
        const decoded2 = new State();
        decoded2.decode(filtered2);

        assert.strictEqual("Jake", decoded1.playerOne.name);
        assert.strictEqual(undefined, decoded1.playerTwo.name);

        assert.strictEqual(undefined, decoded2.playerOne.name);
        assert.strictEqual("Katarina", decoded2.playerTwo.name);
    });

    it("should filter direct properties on root state", () => {
        class State extends Schema {
            @type("string") str: string;

            @filter(function(this: State, client: ClientWithSessionId, value, root) {
                return client.sessionId === "two";
            })
            @type("number") num: number;
        }

        const state = new State();
        state.str = "hello";
        state.num = 1;

        const encoded = state.encode(undefined, undefined, true);

        const full = new State();
        full.decode(encoded);

        const client1 = { sessionId: "one" };
        const client2 = { sessionId: "two" };

        const decoded1 = new State()
        decoded1.decode(state.applyFilters(client1));

        const decoded2 = new State()
        decoded2.decode(state.applyFilters(client2));

        assert.strictEqual("hello", decoded1.str);
        assert.strictEqual("hello", decoded2.str);

        assert.strictEqual(undefined, decoded1.num);
        assert.strictEqual(1, decoded2.num);
    });

    it("should filter array items", () => {
        class Player extends Schema {
            @type("string") name: string;
        }

        class State extends Schema {
            @filterChildren(function(this: Player, client: ClientWithSessionId, key, value: Player, root: State) {
                return (value.name === client.sessionId);
            })
            @type([Player]) players = new ArraySchema<Player>();
        }

        const state = new State();
        state.players.push(new Player({ name: "one" }));
        state.players.push(new Player({ name: "two" }));
        state.players.push(new Player({ name: "three" }));

        const encoded = state.encode(undefined, undefined, true);

        const full = new State();
        full.decode(encoded);

        const client1 = { sessionId: "one" };
        const client2 = { sessionId: "two" };

        const filtered1 = state.applyFilters(client1);
        const decoded1 = new State()
        decoded1.decode(filtered1);

        const filtered2 = state.applyFilters(client2);
        const decoded2 = new State();
        decoded2.decode(filtered2);

        assert.strictEqual("one", decoded1.players[0].name);
        assert.strictEqual(1, decoded1.players.length);

        assert.strictEqual("two", decoded2.players[0].name);
        assert.strictEqual(1, decoded2.players.length);
    });

    it("should filter map items by distance", () => {
        class Entity extends Schema {
            @type("number") x: number;
            @type("number") y: number;
        }

        class Player extends Entity {
            @type("number") radius: number;
        }

        class State extends Schema {
            @filterChildren(function (client, key: string, value: Entity, root: State) {
                const currentPlayer = root.entities.get(client.sessionId);
                if (currentPlayer) {
                    const a = value.x - currentPlayer.x;
                    const b = value.y - currentPlayer.y;

                    return (Math.sqrt(a * a + b * b)) <= 10;

                } else {
                    return false;
                }

            })
            @type({ map: Entity }) entities = new MapSchema<Entity>();
        }

        const state = new State();
        state.entities.set(nanoid(), new Entity().assign({ x: 5, y: 5 }));
        state.entities.set(nanoid(), new Entity().assign({ x: 8, y: 8 }));
        state.entities.set(nanoid(), new Entity().assign({ x: 16, y: 16 }));
        state.entities.set(nanoid(), new Entity().assign({ x: 20, y: 20 }));

        // simulate other player joined before
        state.encode(undefined, undefined, true);
        state.discardAllChanges();

        state.encodeAll(true);

        const client = { sessionId: "player" };

        const decodedState = new State();
        decodedState.entities.onAdd = (entity, key) => console.log("Entity added =>", key, entity.toJSON());
        decodedState.entities.onRemove = (entity, key) => console.log("Entity removed =>", key, entity.toJSON());

        let filteredFullBytes = state.applyFilters(client, true);
        decodedState.decode(filteredFullBytes);

        state.entities.set('player', new Player().assign({ x: 10, y: 10, radius: 1 }));

        state.encode(undefined, undefined, true);
        decodedState.decode(state.applyFilters(client));

        state.encode(undefined, undefined, true);
        decodedState.decode(state.applyFilters(client));

        assert.strictEqual(1, decodedState.entities.size);

        //
        // touch all entities so they're synched again.
        //
        state.entities.forEach(entity => entity['$changes'].touch(0));

        state.encode(undefined, undefined, true);
        decodedState.decode(state.applyFilters(client));
        assert.strictEqual(4, decodedState.entities.size);

        assert.deepEqual([
            { x: 10, y: 10, radius: 1 },
            { x: 5, y: 5 },
            { x: 8, y: 8 },
            { x: 16, y: 16 }
        ], Array.from(decodedState.entities.values()).map(entity => entity.toJSON()));

        //
        // SECOND CLIENT
        //

        // simulate other player joined before
        state.encode(undefined, undefined, true);
        state.discardAllChanges();

        const client2 = { sessionId: "player-2" };

        const decodedState2 = new State();
        decodedState2.entities.onAdd = (entity, key) => console.log("Entity added =>", key, entity.toJSON());
        decodedState2.entities.onRemove = (entity, key) => console.log("Entity removed =>", key, entity.toJSON());

        // simulate other player joined before
        state.encode(undefined, undefined, true);
        state.discardAllChanges();

        decodedState2.decode(state.applyFilters(client2));
        //
        // touch all entities so they're synched again.
        //
        state.entities.forEach(entity => entity['$changes'].touch(0));
        state.entities.set('player-2', new Player().assign({ x: 19, y: 19, radius: 1 }));

        state.encode(undefined, undefined, true);
        decodedState2.decode(state.applyFilters(client2));
        state.discardAllChanges();

        assert.deepEqual([
            { x: 16, y: 16 },
            { x: 20, y: 20 },
            { x: 19, y: 19, radius: 1 },
        ], Array.from(decodedState2.entities.values()).map(entity => entity.toJSON()));

        // // make player 1 and player 2 see each other
        // state.entities.get('player').x += 10;

        // state.encode(undefined, undefined, true);

        // console.log("\n\nREFIDS =>", Array.from(state.entities.entries()).map(([key, entity]) => [key, entity['$changes'].refId]));

        // console.log("\n\nWILL APPLY FILTERS AGAIN");
        // decodedState2.decode(state.applyFilters(client2));
        // console.log(decodedState2.toJSON());
    });

    it("DELETE inside map of Schema", () => {
        class Card extends Schema {
            @type("string") suit: string;
            @type("number") number: number;
            @type("string") ownerId: string;
            @type("boolean") revealed: boolean;
        }

        class State extends Schema {
            @filterChildren(function (client: any, key: string, value: Card, root: State) {
                return (value.ownerId === client.sessionId) || value.revealed;
            })
            @type({ map: Card }) cards = new MapSchema<Card>();
        }

        const client1 = { sessionId: "one" };
        const client2 = { sessionId: "two" };

        const state = new State();

        // add 10 cards for player 'one'
        for (let i = 0; i < 10; i++) {
            state.cards.set('c' + i, new Card().assign({
                suit: 'H',
                number: i + 1,
                ownerId: "one"
            }));
        }

        // add 10 cards for player 'two'
        for (let i = 10; i < 20; i++) {
            state.cards.set('c' + i, new Card().assign({
                suit: 'S',
                number: i + 1,
                ownerId: "two"
            }));
        }

        // add 3 cards for player 'three'
        for (let i = 20; i < 23; i++) {
            state.cards.set('c' + i, new Card().assign({
                suit: 'C',
                number: i + 1,
                ownerId: "three"
            }));
        }

        // simulate other player joined before
        state.encode(undefined, undefined, true);
        state.discardAllChanges();

        let fullBytes = state.encodeAll(true);

        const decodedState1 = new State();
        decodedState1.cards.onAdd = (card, key) => {};
        decodedState1.cards.onRemove = (card, key) => {
            // console.log("decodedState1, onRemove =>", card, key);
        };
        let client1OnAddCard = sinon.spy(decodedState1.cards, 'onAdd');
        let client1OnRemoveCard = sinon.spy(decodedState1.cards, 'onRemove');

        decodedState1.decode(state.applyFilters(client1, true));
        sinon.assert.callCount(client1OnAddCard, 10);
        sinon.assert.callCount(client1OnRemoveCard, 0);

        const decodedState2 = new State();
        decodedState2.cards.onAdd = (card, key) => {};
        decodedState2.cards.onRemove = (card, key) => {
            // console.log("decodedState2, onRemove =>", card, key);
        };
        let client2OnAddCard = sinon.spy(decodedState2.cards, 'onAdd');
        let client2OnRemoveCard = sinon.spy(decodedState2.cards, 'onRemove');

        decodedState2.decode(state.applyFilters(client2, true));
        sinon.assert.callCount(client2OnAddCard, 10);
        sinon.assert.callCount(client2OnRemoveCard, 0);

        // reveal two cards from player 1
        state.cards.get('c1').revealed = true;
        state.cards.get('c2').revealed = true;

        // reveal two cards from player 2
        state.cards.get('c11').revealed = true;
        state.cards.get('c12').revealed = true;

        state.encode(undefined, undefined, true);
        decodedState1.decode(state.applyFilters(client1));
        decodedState2.decode(state.applyFilters(client2));

        sinon.assert.callCount(client1OnAddCard, 12);
        sinon.assert.callCount(client2OnAddCard, 12);

        // remove 1 card from player 1
        state.cards.delete('c2');

        // remove 1 card from player 2
        state.cards.delete('c12');

        // remove 2 cards from player 3
        state.cards.delete('c20');
        state.cards.delete('c21');

        state.encode(undefined, undefined, true);
        decodedState1.decode(state.applyFilters(client1));
        decodedState2.decode(state.applyFilters(client2));

        sinon.assert.callCount(client1OnAddCard, 12);
        sinon.assert.callCount(client1OnRemoveCard, 2);

        sinon.assert.callCount(client2OnAddCard, 12);
        sinon.assert.callCount(client2OnRemoveCard, 2);

        assert.deepEqual({
            cards: {
                c0: { suit: 'H', number: 1, ownerId: 'one' },
                c1: { suit: 'H', number: 2, ownerId: 'one', revealed: true },
                c3: { suit: 'H', number: 4, ownerId: 'one' },
                c4: { suit: 'H', number: 5, ownerId: 'one' },
                c5: { suit: 'H', number: 6, ownerId: 'one' },
                c6: { suit: 'H', number: 7, ownerId: 'one' },
                c7: { suit: 'H', number: 8, ownerId: 'one' },
                c8: { suit: 'H', number: 9, ownerId: 'one' },
                c9: { suit: 'H', number: 10, ownerId: 'one' },
                c11: { suit: 'S', number: 12, ownerId: 'two', revealed: true }
            }
        }, decodedState1.toJSON())

        assert.deepEqual({
            cards: {
                c10: { suit: 'S', number: 11, ownerId: 'two' },
                c11: { suit: 'S', number: 12, ownerId: 'two', revealed: true },
                c13: { suit: 'S', number: 14, ownerId: 'two' },
                c14: { suit: 'S', number: 15, ownerId: 'two' },
                c15: { suit: 'S', number: 16, ownerId: 'two' },
                c16: { suit: 'S', number: 17, ownerId: 'two' },
                c17: { suit: 'S', number: 18, ownerId: 'two' },
                c18: { suit: 'S', number: 19, ownerId: 'two' },
                c19: { suit: 'S', number: 20, ownerId: 'two' },
                c1: { suit: 'H', number: 2, ownerId: 'one', revealed: true }
            }
        }, decodedState2.toJSON());
    });

    it("DELETE inside collection of primitive values", () => {
        class State extends Schema {
            @filterChildren(function (client: any, key: string, value: string, root: State) {
                return value.includes(client.sessionId);
            })
            @type({ map: "string" }) items = new MapSchema<string>();
        }

        const client1 = { sessionId: "one" };
        const client2 = { sessionId: "two" };

        const state = new State();

        // add 10 items for player 'one'
        for (let i = 0; i < 10; i++) {
            state.items.set('c' + i, 'one' + i);
        }

        // add 10 items for player 'two'
        for (let i = 10; i < 20; i++) {
            state.items.set('c' + i, 'two' + i);
        }

        // add 3 items for player 'three'
        for (let i = 20; i < 23; i++) {
            state.items.set('c' + i, 'three' + i);
        }

        // simulate other player joined before
        state.encode(undefined, undefined, true);
        state.discardAllChanges();

        state.encodeAll(true);

        const decodedState1 = new State();
        decodedState1.items.onAdd = (item, key) => {};
        decodedState1.items.onChange = (item, key) => {
            console.log("decodedState1 -> onChange", {item, key})
        };
        decodedState1.items.onRemove = (item, key) => {
            // console.log("decodedState1, onRemove =>", item, key);
        };
        let client1OnAddCard = sinon.spy(decodedState1.items, 'onAdd');
        let client1OnRemoveCard = sinon.spy(decodedState1.items, 'onRemove');

        decodedState1.decode(state.applyFilters(client1, true));

        sinon.assert.callCount(client1OnAddCard, 10);
        sinon.assert.callCount(client1OnRemoveCard, 0);

        const decodedState2 = new State();
        decodedState2.items.onAdd = (item, key) => {};
        decodedState2.items.onChange = (item, key) => {
            console.log("decodedState2 -> onChange", {item, key})
        };
        decodedState2.items.onRemove = (item, key) => {
            // console.log("decodedState2, onRemove =>", item, key);
        };
        let client2OnAddCard = sinon.spy(decodedState2.items, 'onAdd');
        let client2OnRemoveCard = sinon.spy(decodedState2.items, 'onRemove');

        decodedState2.decode(state.applyFilters(client2, true));

        sinon.assert.callCount(client2OnAddCard, 10);
        sinon.assert.callCount(client2OnRemoveCard, 0);

        // reveal two items from player 1
        state.items.set('c1', 'onetwo1');
        state.items.set('c2', 'onetwo2');

        // reveal two items from player 2
        state.items.set('c11', 'twoone11');
        state.items.set('c12', 'twoone12');

        state.encode(undefined, undefined, true);
        decodedState1.decode(state.applyFilters(client1));
        decodedState2.decode(state.applyFilters(client2));

        sinon.assert.callCount(client1OnAddCard, 12);
        sinon.assert.callCount(client2OnAddCard, 12);

        // remove 1 item from player 1
        state.items.delete('c2');

        // remove 1 item from player 2
        state.items.delete('c12');

        // remove 2 items from player 3
        state.items.delete('c20');
        state.items.delete('c21');

        // change 2 items
        state.items.set('c11', 'twoone11 changed');

        state.encode(undefined, undefined, true);
        decodedState1.decode(state.applyFilters(client1));
        decodedState2.decode(state.applyFilters(client2));

        console.log(decodedState1.toJSON());

        sinon.assert.callCount(client1OnAddCard, 12);
        sinon.assert.callCount(client1OnRemoveCard, 2);

        sinon.assert.callCount(client2OnAddCard, 12);
        sinon.assert.callCount(client2OnRemoveCard, 2);

        assert.strictEqual(undefined, decodedState1.items.get('c2'));
        assert.strictEqual(undefined, decodedState1.items.get('c12'));

        assert.deepEqual({
            items: {
                c0: 'one0',
                c1: 'onetwo1',
                c3: 'one3',
                c4: 'one4',
                c5: 'one5',
                c6: 'one6',
                c7: 'one7',
                c8: 'one8',
                c9: 'one9',
                c11: 'twoone11 changed'
            }
        }, decodedState1.toJSON());

        assert.deepEqual({
            items: {
                c10: 'two10',
                c11: 'twoone11 changed',
                c13: 'two13',
                c14: 'two14',
                c15: 'two15',
                c16: 'two16',
                c17: 'two17',
                c18: 'two18',
                c19: 'two19',
                c1: 'onetwo1'
            }
        }, decodedState2.toJSON());
    });

    it("DELETE a primitive value of Schema", () => {
        const filterCard = function(this: Card, client: ClientWithSessionId, value: any, root: State) {
            return this.revealed || root.players.get(client.sessionId).cards.includes(this);
        }

        class Card extends Schema {
            @filter(filterCard)
            @type("string") suit: string;

            @filter(filterCard)
            @type("number") number: number;

            @type("boolean") revealed: boolean;
        }

        class Player extends Schema {
            @type([Card]) cards: Card[] = new ArraySchema<Card>();
        }

        class State extends Schema {
            @type({ map: Player }) players = new MapSchema<Player>();
        }

        const state = new State();

        const client1 = { sessionId: "one" };
        const decoded1 = new State();

        const client2 = { sessionId: "two" };
        const decoded2 = new State();

        [client1, client2].forEach(client => {
            // simulate other player joined before
            state.encode(undefined, undefined, true);
            state.discardAllChanges();

            state.players.set(client.sessionId, new Player().assign({
                cards: [
                    new Card().assign({ suit: "S", number: 1 }),
                    new Card().assign({ suit: "C", number: 2 }),
                    new Card().assign({ suit: "H", number: 3 }),
                ]
            }));
        });

        state.encodeAll(true);
        decoded1.decode(state.applyFilters(client1, true));
        decoded2.decode(state.applyFilters(client2, true));
        state.discardAllChanges();

        assert.deepEqual({
            players: {
                one: {
                    cards: [
                        { suit: 'S', number: 1 },
                        { suit: 'C', number: 2 },
                        { suit: 'H', number: 3 }
                    ]
                },
                two: { cards: [{}, {}, {}] }
            }
        }, decoded1.toJSON());

        assert.deepEqual({
            players: {
                one: { cards: [{}, {}, {}] },
                two: {
                    cards: [
                        { suit: 'S', number: 1 },
                        { suit: 'C', number: 2 },
                        { suit: 'H', number: 3 }
                    ]
                }
            }
        }, decoded2.toJSON());

        // reveal a card on each player's hand.
        state.players.get('one').cards[1].revealed = true;
        state.players.get('two').cards[2].revealed = true;

        state.encode(undefined, undefined, true)
        decoded1.decode(state.applyFilters(client1));
        decoded2.decode(state.applyFilters(client2));
        state.discardAllChanges();

        assert.deepEqual({ suit: 'H', number: 3, revealed: true }, decoded1.players.get('two').cards[2].toJSON())
        assert.deepEqual({ suit: 'C', number: 2, revealed: true }, decoded1.players.get('one').cards[1].toJSON())

        // clear suit of all cards with index > 0
        state.players.forEach(player => {
            player.cards.forEach((card, i) => {
                if (i > 0) {
                    card.suit = undefined;
                }
            })
        });

        // listenn for "suit" change on both players
        let suitChanged: number = 0;
        decoded1.players.forEach(player => {
            player.cards.forEach(card => {
                card.listen("suit", (value) => suitChanged++);
            });
        });

        decoded2.players.forEach(player => {
            player.cards.forEach(card => {
                card.listen("suit", (value) => suitChanged++);
            });
        });

        state.encode(undefined, undefined, true)
        decoded1.decode(state.applyFilters(client1));
        decoded2.decode(state.applyFilters(client2));
        state.discardAllChanges();

        assert.strictEqual(8, suitChanged, "should have nullified 8 cards.");

        assert.deepEqual({
            players: {
                one: {
                    cards: [
                        { suit: 'S', number: 1 },
                        { number: 2, revealed: true },
                        { number: 3 }
                    ]
                },
                two: { cards: [{}, {}, { number: 3, revealed: true }] }
            }
        }, decoded1.toJSON())

        assert.deepEqual({
            players: {
                one: { cards: [{}, { number: 2, revealed: true }, {}] },
                two: {
                    cards: [
                        { suit: 'S', number: 1 },
                        { number: 2 },
                        { number: 3, revealed: true }
                    ]
                }
            }
        }, decoded2.toJSON())
    });

    it("DELETE a direct Schema instance", () => {
        const filterCard = function(this: Player, client: ClientWithSessionId, value: Card, root: State) {
            const currentPlayer = root.players.get(client.sessionId);
            return (
                value.revealed ||
                [
                    currentPlayer.card1,
                    currentPlayer.card2,
                    currentPlayer.card3
                ].includes(value)
            )
        }

        class Card extends Schema {
            @type("string") suit: string;
            @type("number") number: number;
            @type("boolean") revealed: boolean;
        }

        class Player extends Schema {
            @filter(filterCard)
            @type(Card) card1: Card;

            @filter(filterCard)
            @type(Card) card2: Card;

            @filter(filterCard)
            @type(Card) card3: Card;
        }

        class State extends Schema {
            @type({ map: Player }) players = new MapSchema<Player>();
        }

        const state = new State();

        const client1 = { sessionId: "one" };
        const decoded1 = new State();

        const client2 = { sessionId: "two" };
        const decoded2 = new State();

        [client1, client2].forEach(client => {
            // simulate other player joined before
            state.encode(undefined, undefined, true);
            state.discardAllChanges();

            state.players.set(client.sessionId, new Player().assign({
                card1: new Card().assign({ suit: "S", number: 1 }),
                card2: new Card().assign({ suit: "C", number: 2 }),
                card3: new Card().assign({ suit: "H", number: 3 }),
            }));
        });

        state.encodeAll(true);
        decoded1.decode(state.applyFilters(client1, true));
        decoded2.decode(state.applyFilters(client2, true));
        state.discardAllChanges();

        console.log(util.inspect(decoded1.toJSON(), false, 4));
        console.log(util.inspect(decoded2.toJSON(), false, 4));

        assert.deepEqual({
            players: {
                one: {
                    card1: { suit: 'S', number: 1 },
                    card2: { suit: 'C', number: 2 },
                    card3: { suit: 'H', number: 3 }
                },
                two: {}
            }
        }, decoded1.toJSON());

        assert.deepEqual({
            players: {
                one: {},
                two: {
                    card1: { suit: 'S', number: 1 },
                    card2: { suit: 'C', number: 2 },
                    card3: { suit: 'H', number: 3 }
                }
            }
        }, decoded2.toJSON());

        // reveal a card on each player's hand.
        state.players.get('one').card2.revealed = true;
        state.players.get('two').card3.revealed = true;

        state.encode(undefined, undefined, true)
        decoded1.decode(state.applyFilters(client1));
        decoded2.decode(state.applyFilters(client2));
        state.discardAllChanges();

        assert.deepEqual({ suit: 'H', number: 3, revealed: true }, decoded1.players.get('two').card3.toJSON())
        assert.deepEqual({ suit: 'C', number: 2, revealed: true }, decoded1.players.get('one').card2.toJSON())

        // clear suit of all cards with index > 0
        state.players.forEach(player => {
            player.card2 = undefined;
            player.card3 = undefined;
        });

        state.encode(undefined, undefined, true)
        decoded1.decode(state.applyFilters(client1));
        decoded2.decode(state.applyFilters(client2));
        state.discardAllChanges();

        assert.deepEqual({
            players: { one: { card1: { suit: 'S', number: 1 } }, two: {} }
        }, decoded1.toJSON());

        assert.deepEqual({
            players: { one: {}, two: { card1: { suit: 'S', number: 1 } } }
        }, decoded2.toJSON());
    });

    // it("should filter property outside of root", () => {
    //     const state = new StateWithFilter();
    //     state.filteredNumber = 10;

    //     state.units.one = new Unit();
    //     state.units.one.inventory = new Inventory();
    //     state.units.one.inventory.items = 10;

    //     state.units.two = new Unit();
    //     state.units.two.inventory = new Inventory();
    //     state.units.two.inventory.items = 20;

    //     const client1 = { sessionId: "one" };
    //     const client2 = { sessionId: "two" };
    //     const client3 = { sessionId: "three" };

    //     const decoded1 = (new StateWithFilter()).decode(state.encodeFiltered(client1));
    //     state.encodeAllFiltered(client3);
    //     const decoded2 = (new StateWithFilter()).decode(state.encodeFiltered(client2));

    //     assert.strictEqual(decoded1.units.one.inventory.items, 10);
    //     assert.strictEqual(decoded1.units.two.inventory, undefined);
    //     assert.strictEqual(decoded1.filteredNumber, 10);

    //     assert.strictEqual(decoded2.units.one.inventory, undefined);
    //     assert.strictEqual(decoded2.units.two.inventory.items, 20);
    //     assert.strictEqual(decoded2.filteredNumber, undefined);
    // });

    // xit("should filter map entries by distance", () => {
    //     const state = new StateWithFilter();
    //     state.unitsWithDistanceFilter = new MapSchema<Unit>();

    //     const createUnit = (key: string, x: number, y: number) => {
    //         const unit = new Unit();
    //         unit.x = x;
    //         unit.y = y;
    //         state.unitsWithDistanceFilter[key] = unit;
    //     };

    //     createUnit("one", 0, 0);
    //     createUnit("two", 10, 0);
    //     createUnit("three", 15, 0);
    //     createUnit("four", 20, 0);
    //     createUnit("five", 50, 0);

    //     const client1 = { sessionId: "one" };
    //     const client2 = { sessionId: "two" };
    //     const client3 = { sessionId: "three" };
    //     const client4 = { sessionId: "four" };
    //     const client5 = { sessionId: "five" };

    //     const decoded1 = (new StateWithFilter()).decode(state.encodeFiltered(client1));
    //     const decoded2 = (new StateWithFilter()).decode(state.encodeFiltered(client2));
    //     const decoded3 = (new StateWithFilter()).decode(state.encodeFiltered(client3));
    //     const decoded4 = (new StateWithFilter()).decode(state.encodeFiltered(client4));
    //     const decoded5 = (new StateWithFilter()).decode(state.encodeFiltered(client5));

    //     assert.deepEqual(Object.keys(decoded1.unitsWithDistanceFilter), ['one', 'two']);
    //     assert.deepEqual(Object.keys(decoded2.unitsWithDistanceFilter), ['one', 'two', 'three', 'four']);
    //     assert.deepEqual(Object.keys(decoded3.unitsWithDistanceFilter), ['two', 'three', 'four']);
    //     assert.deepEqual(Object.keys(decoded4.unitsWithDistanceFilter), ['two', 'three', 'four']);
    //     assert.deepEqual(Object.keys(decoded5.unitsWithDistanceFilter), ['five']);
    // });

    // xit("should trigger onAdd when filter starts to match", () => {
    //     const state = new StateWithFilter();
    //     state.unitsWithDistanceFilter = new MapSchema<Unit>();

    //     const client5 = { sessionId: "five" };

    //     // FIRST DECODE
    //     const decoded5 = (new StateWithFilter()).decode(state.encodeFiltered(client5));
    //     assert.strictEqual(JSON.stringify(decoded5), '{"units":{},"unitsWithDistanceFilter":{}}');

    //     const createUnit = (key: string, x: number, y: number) => {
    //         const unit = new Unit();
    //         unit.x = x;
    //         unit.y = y;
    //         state.unitsWithDistanceFilter[key] = unit;
    //     };

    //     createUnit("one", 0, 0);
    //     createUnit("two", 10, 0);
    //     createUnit("three", 15, 0);
    //     createUnit("four", 20, 0);
    //     createUnit("five", 50, 0);

    //     // SECOND DECODE
    //     decoded5.decode(state.encodeFiltered(client5));
    //     assert.strictEqual(JSON.stringify(decoded5), '{"units":{},"unitsWithDistanceFilter":{"five":{"x":50,"y":0}}}');

    //     assert.deepEqual(Object.keys(decoded5.unitsWithDistanceFilter), ['five']);

    //     // SECOND DECODE
    //     state.unitsWithDistanceFilter.five.x = 30;
    //     decoded5.unitsWithDistanceFilter.onAdd = function(item, key) {}
    //     let onAddSpy = sinon.spy(decoded5.unitsWithDistanceFilter, 'onAdd');

    //     decoded5.decode(state.encodeFiltered(client5));
    //     assert.strictEqual(JSON.stringify(decoded5), '{"units":{},"unitsWithDistanceFilter":{"five":{"x":30,"y":0},"four":{"x":20,"y":0}}}');

    //     assert.deepEqual(Object.keys(decoded5.unitsWithDistanceFilter), ['five', 'four']);

    //     // THIRD DECODE
    //     state.unitsWithDistanceFilter.five.x = 17;
    //     decoded5.decode(state.encodeFiltered(client5));
    //     assert.strictEqual(JSON.stringify(decoded5), '{"units":{},"unitsWithDistanceFilter":{"five":{"x":17,"y":0},"four":{"x":20,"y":0},"two":{"x":10,"y":0},"three":{"x":15,"y":0}}}');

    //     assert.deepEqual(Object.keys(decoded5.unitsWithDistanceFilter), ['five', 'four', 'two', 'three']);
    //     sinon.assert.calledThrice(onAddSpy);
    // });

    // xit("should trigger onRemove when filter by distance doesn't match anymore", () => {
    //     const state = new StateWithFilter();
    //     state.unitsWithDistanceFilter = new MapSchema<Unit>();

    //     const createUnit = (key: string, x: number, y: number) => {
    //         const unit = new Unit();
    //         unit.x = x;
    //         unit.y = y;
    //         state.unitsWithDistanceFilter[key] = unit;
    //     };

    //     createUnit("one", 0, 0);
    //     createUnit("two", 10, 0);
    //     createUnit("three", 20, 0);

    //     const client2 = { sessionId: "two" };

    //     const decoded2 = new StateWithFilter();
    //     decoded2.unitsWithDistanceFilter.onAdd = function(unit, key) {
    //         console.log("onAdd =>", key);
    //     }
    //     decoded2.unitsWithDistanceFilter.onRemove = function(unit, key) {
    //         console.log("onRemove =>", key);
    //     }
    //     const onAddSpy = sinon.spy(decoded2.unitsWithDistanceFilter, 'onAdd');
    //     const onRemoveSpy = sinon.spy(decoded2.unitsWithDistanceFilter, 'onRemove');

    //     decoded2.decode(state.encodeFiltered(client2));

    //     state.unitsWithDistanceFilter['three'].x = 21;
    //     decoded2.decode(state.encodeFiltered(client2));

    //     sinon.assert.calledThrice(onAddSpy);
    //     // assert.deepEqual(Object.keys(decoded2.unitsWithDistanceFilter), ['one', 'two', 'three', 'four']);
    // });

    // it("should not trigger `onChange` if field haven't changed", () => {
    //     const state = new StateWithFilter();
    //     state.filteredNumber = 10;

    //     const client1 = { sessionId: "one" };

    //     const decoded1 = new StateWithFilter();
    //     decoded1.decode(state.encodeFiltered(client1));

    //     let changes: DataChange[];

    //     decoded1.onChange = (changelist) => changes = changelist;

    //     state.unfilteredString = "20";
    //     decoded1.decode(state.encodeFiltered(client1));

    //     assert.deepEqual([
    //         { field: 'unfilteredString', value: '20', previousValue: undefined }
    //     ], changes);

    //     state.filteredNumber = 11;
    //     decoded1.decode(state.encodeFiltered(client1));
    //     assert.deepEqual([
    //         { field: 'filteredNumber', value: 11, previousValue: 10 }
    //     ], changes);
    // });
});