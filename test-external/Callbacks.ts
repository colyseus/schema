import { Schema, type, ArraySchema } from "../src";

class Ref extends Schema {
    @type("number") num: number;
}

class Container extends Schema {
    @type("number") num: number;
    @type("string") str: string;
    @type(Ref) aRef: Ref = new Ref();

    @type([Ref]) arrayOfSchemas = new ArraySchema<Ref>();
    @type(["number"]) arrayOfNumbers = new ArraySchema<number>();
    @type(["string"]) arrayOfStrings = new ArraySchema<string>();
}

class CallbacksState extends Schema {
    @type(Container) container: Container = new Container();
}

const state = new CallbacksState();
let bytes = Array.from(Uint8Array.from(Buffer.from(state.encode())));

console.log("(initial) Callbacks =>");
console.log(`{ ${bytes.join(", ")} }`);

state.container.num = 1;
state.container.str = "one";
state.container.aRef.num = 1;
state.container.arrayOfSchemas.push(new Ref().assign({ num: 2 }));
state.container.arrayOfNumbers.push(1);
state.container.arrayOfStrings.push("one");

bytes = Array.from(Uint8Array.from(Buffer.from( state.encode() )));

console.log("(populate) Callbacks =>");
console.log(`{ ${bytes.join(", ")} }`);

state.container = new Container();
state.container.num = 2;
state.container.str = "two";
state.container.aRef.num = 2;
state.container.arrayOfSchemas.push(new Ref().assign({ num: 4 }));
state.container.arrayOfNumbers.push(2);
state.container.arrayOfStrings.push("two");

bytes = Array.from(Uint8Array.from(Buffer.from( state.encode() )));

console.log("(reset) Callbacks =>");
console.log(`{ ${bytes.join(", ")} }`);
