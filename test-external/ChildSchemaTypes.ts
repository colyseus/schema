import { Schema, type } from "../src";

class IAmAChild extends Schema {
  @type("number") x: number;
  @type("number") y: number;
}

class ChildSchemaTypes extends Schema {
  @type(IAmAChild) child: IAmAChild;
  @type(IAmAChild) secondChild: IAmAChild;
}

const state = new ChildSchemaTypes();
state.child = new IAmAChild();
state.child.x = 500;
state.child.y = 800;

state.secondChild = new IAmAChild()
state.secondChild.x = 200;
state.secondChild.y = 300;

const bytes = Array.from(Uint8Array.from(Buffer.from( state.encode() )));

console.log("ChildSchemaTypes =>");
console.log(`{ ${bytes.join(", ")} }`);