import { Schema, type, filter, filterChildren, ArraySchema } from "../src";
import { Client } from "../src/annotations";

const playerFilter = function (this: Player, client: Client, value, root: State) {
    return (
        (root.playerOne === value && client.sessionId === "one") ||
        (root.playerTwo === value && client.sessionId === "two")
    );
}

class Player extends Schema {
    @type("string") name: string;
}

class State extends Schema {
    @filter(playerFilter)
    @type(Player) playerOne: Player;

    @filter(playerFilter)
    @type(Player) playerTwo: Player;

    @filterChildren(function(this: Player, client: Client, key, value: Player, root: State) {
        return (value.name === client.sessionId);
    })
    @type([Player]) players = new ArraySchema<Player>();
}

const state = new State();

state.playerOne = new Player({ name: "one" });
state.players.push(state.playerOne.clone());

state.playerTwo = new Player({ name: "two" });
state.players.push(state.playerTwo.clone());

state.players.push(new Player({ name: "three" }));

const encoded = state.encode(undefined, undefined, true);

const full = new State();
full.decode(encoded);

const client1 = { sessionId: "one" };
const client2 = { sessionId: "two" };

const filtered1 = state.applyFilters(client1);
console.log(`client 'one' => { ${filtered1.join(", ")} }`);

const decoded1 = new State();
decoded1.decode(filtered1);
console.log("=>", decoded1.toJSON());

const filtered2 = state.applyFilters(client2);
console.log(`client 'two' => { ${filtered2.join(", ")} }`);

const decoded2 = new State();
decoded2.decode(filtered2);
console.log("=>", decoded2.toJSON());