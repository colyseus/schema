import { Schema, type, MapSchema, ArraySchema, Encoder } from "../src";

class Item extends Schema {
    @type("string") name: string;
    @type("number") value: number;
}

class Vec3 extends Schema {
    @type("number") x: number = 1;
    @type("number") y: number = 2;
    @type("number") z: number = 3;
}

class Player extends Schema {
    @type(Vec3) position;
    @type({ map: Item }) items;
}

class Container extends Schema {
    @type({ map: Player }) playersMap = new MapSchema<Player>();
}

class CallbacksState extends Schema {
    @type(Container) container: Container = new Container();
}

const state = new CallbacksState();
const encoder = new Encoder(state);

let bytes = Array.from(Uint8Array.from(Buffer.from(encoder.encode())));

console.log("(initial) Callbacks =>");
console.log(`{ ${bytes.join(", ")} }`);

state.container.playersMap.set("one", new Player().assign({
    position: new Vec3(),
    items: new MapSchema({
        "item-1": new Item().assign({ name: "Item 1", value: 1 }),
        "item-2": new Item().assign({ name: "Item 2", value: 2 }),
        "item-3": new Item().assign({ name: "Item 3", value: 3 }),
    })
}))

state.container.playersMap.set("two", new Player().assign({
    position: new Vec3(),
    items: new MapSchema({
        "item-1": new Item().assign({ name: "Item 1", value: 1 }),
        "item-2": new Item().assign({ name: "Item 2", value: 2 }),
        "item-3": new Item().assign({ name: "Item 3", value: 3 }),
    })
}))

bytes = Array.from(Uint8Array.from(Buffer.from( encoder.encode() )));

console.log("(1st encode) Callbacks =>");
console.log(`{ ${bytes.join(", ")} }`);

// ... delete 2 items (from player "one")
state.container.playersMap.get("one")!.items.delete("item-1");
state.container.playersMap.get("one")!.items.delete("item-2");
// ... add 1 item (to player "one")
state.container.playersMap.get("one")!.items.set("item-4", new Item().assign({ name: "Item 4", value: 4 }));

// ... delete player "two"
state.container.playersMap.delete("two");

// ... add player "three"
state.container.playersMap.set("three", new Player().assign({
    position: new Vec3(),
    items: new MapSchema({
        "item-1": new Item().assign({ name: "Item 1", value: 1 }),
        "item-2": new Item().assign({ name: "Item 2", value: 2 }),
        "item-3": new Item().assign({ name: "Item 3", value: 3 }),
    })
}))

bytes = Array.from(Uint8Array.from(Buffer.from( encoder.encode() )));
console.log("(2nd encode - remove 1 player; remove 2 items; add new player) Callbacks =>");
console.log(`{ ${bytes.join(", ")} }`);

state.container = new Container();
state.container.playersMap.set("last", new Player().assign({
    position: new Vec3().assign({ x: 10, y: 10, z: 10 }),
    items: new MapSchema<Item>({
        "one": new Item().assign({ name: "Item 1", value: 1 })
    })
}))

bytes = Array.from(Uint8Array.from(Buffer.from( encoder.encode() )));
console.log("(new container) Callbacks =>");
console.log(`{ ${bytes.join(", ")} }`);
