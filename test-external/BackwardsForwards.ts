import { Schema, type, MapSchema, ArraySchema, deprecated, Reflection } from "../src";

function printBytes(arr) {
    console.log(`{ ${Array.from(Uint8Array.from(Buffer.from(arr))).join(", ")} }`);
}

class PlayerV1 extends Schema {
    @type("number") x: number = Math.random();
    @type("number") y: number = Math.random();
}

class StateV1 extends Schema {
    @type("string") str: string;
    @type({ map: PlayerV1 }) map = new MapSchema<PlayerV1>();
}

class PlayerV2 extends Schema {
    @type("number") x: number = Math.random();
    @type("number") y: number = Math.random();
    @type("string") name = "Jake Badlands";
    @type(["string"]) arrayOfStrings = new ArraySchema<string>("one", "two", "three");
}

class StateV2 extends Schema {
    @type("string") str: string;

    @deprecated()
    @type({ map: PlayerV2 }) map = new MapSchema<PlayerV2>();

    @type("number") countdown: number;
}

const statev1 = new StateV1();
statev1.str = "Hello world";
statev1.map['one'] = new PlayerV1();

console.log("StateV1 Handshake =>");
printBytes(Reflection.encode(statev1));

console.log("StateV1 =>");
printBytes(statev1.encode())

const statev2 = new StateV2();
statev2.str = "Hello world";
statev2.countdown = 10;

console.log("StateV2 Handshake =>");
printBytes(Reflection.encode(statev2))

console.log("StateV2 =>");
printBytes(statev2.encode());