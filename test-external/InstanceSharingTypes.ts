import { Schema, type, ArraySchema, MapSchema, Encoder } from "../src";

class Position extends Schema {
    @type("number") x: number;
    @type("number") y: number;
}

class Player extends Schema {
    @type(Position) position = new Position();
}

class State extends Schema {
    @type(Player) player1: Player;
    @type(Player) player2: Player;
    @type([Player]) arrayOfPlayers = new ArraySchema<Player>();
    @type({ map: Player }) mapOfPlayers = new MapSchema<Player>();
}

const state = new State();
const encoder = new Encoder(state);

const player1 = new Player().assign({
    position: new Position().assign({ x: 10, y: 10 })
});

state.player1 = player1;
state.player2 = player1;

console.log(`InstanceSharingTypes => { ${encoder.encodeAll().join(", ")} }`);
encoder.discardChanges();

state.player1 = undefined;
state.player2 = undefined;

console.log(`InstanceSharingTypes => { ${encoder.encode().join(", ")} }`);
encoder.discardChanges();

const player2 = new Player().assign({
     position: new Position().assign({ x: 10, y: 10 })
});
state.arrayOfPlayers.push(player2);
state.arrayOfPlayers.push(player2);
state.arrayOfPlayers.push(player2);

const player3 = new Player().assign({
    position: new Position().assign({ x: 10, y: 10 })
});
state.arrayOfPlayers.push(player3);

console.log(`InstanceSharingTypes => { ${encoder.encode().join(", ")} }`);
encoder.discardChanges();

state.arrayOfPlayers.pop();
state.arrayOfPlayers.pop();
state.arrayOfPlayers.pop();

console.log(`InstanceSharingTypes => { ${encoder.encode().join(", ")} }`);
encoder.discardChanges();

// replace ArraySchema
state.arrayOfPlayers = new ArraySchema<Player>();
state.arrayOfPlayers.push(new Player().assign({ position: new Position().assign({ x: 10, y: 20 }) }));

console.log(`InstanceSharingTypes => { ${encoder.encode().join(", ")} }`);
encoder.discardChanges();

console.log(Schema.debugRefIds(state))

state.arrayOfPlayers.clear();
console.log(`InstanceSharingTypes => { ${encoder.encode().join(", ")} }`);
encoder.discardChanges();