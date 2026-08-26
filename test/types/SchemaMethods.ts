import { Schema, ArraySchema, MapSchema, type, type ToJSON } from "../../build/index.js";

// The four `this`-dependent Schema methods, exercised from a subclass under
// `strict`.

class Player extends Schema {
    @type("string") name!: string;
    @type("number") hp!: number;
    hit() { this.hp--; }
}

class State extends Schema {
    @type({ map: Player }) players = new MapSchema<Player>();
    @type([Player]) list = new ArraySchema<Player>();
}

// assign() keeps the subclass for chaining, and only takes fields
const assigned: Player = new Player().assign({ name: "x", hp: 1 });
// @ts-expect-error — not a field
new Player().assign({ nope: 1 });
new State().assign({ players: { a: { name: "a", hp: 1 } }, list: [{ name: "b", hp: 2 }] });
void assigned;

// restore() accepts a plain literal of the fields — no Schema machinery required
const restored: Player = new Player().restore({ name: "a", hp: 2 });
void restored;

// toJSON() is the fields alone: no methods, no machinery
const json = new Player().toJSON();
const jsonName: string = json.name;
// @ts-expect-error — not in the JSON shape
json.hit;
// @ts-expect-error — not in the JSON shape
json.isTrackingPaused;
const stateJson: ToJSON<State> = new State().toJSON();
const stateJsonPlayers: Record<string, { name: string; hp: number }> = stateJson.players;
void jsonName; void stateJsonPlayers;

// overrides need no annotation
class Custom extends Player {
    assign(props: any) { super.assign(props); return this; }
    restore(json: any) { return super.restore(json); }
    toJSON() { return { ...super.toJSON(), extra: 1 }; }
}
void Custom;

// the JSON shape is reachable through the method type as well as `ToJSON<>`
const viaReturnType: ReturnType<Player["toJSON"]> = { name: "a", hp: 1 };
void viaReturnType;

// setDirty() takes field names only
new Player().setDirty("hp");
// @ts-expect-error — not a field
new Player().setDirty("hit");
