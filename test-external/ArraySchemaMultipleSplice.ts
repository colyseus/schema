import "./boot"
import { Schema, type, ArraySchema } from "../src";

class Item extends Schema {
  @type("string") name: string;
}

class Player extends Schema {
  @type([Item]) items = new ArraySchema<Item>();
}

class MultipleArraySpliceState extends Schema {
  @type(Player) player = new Player();
}

const state = new MultipleArraySpliceState();
const decodedState = new MultipleArraySpliceState();

decodedState.decode(state.encode());
state.player.items.push(new Item().assign({ name: "Item 1" }));

decodedState.decode(state.encode());

state.player.items.push(new Item().assign({ name: "Item 2" }));
state.player.items.push(new Item().assign({ name: "Item 3" }));

decodedState.decode(state.encode());

// ========================================

// Remove Items 1 and 2 in two separate splice executions
state.player.items.splice(0, 1);
state.player.items.splice(0, 1);

decodedState.decode(state.encode());