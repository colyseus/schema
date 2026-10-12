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

// Direct collection serialization preserves values instead of leaking any.
type IsAny<T> = 0 extends (1 & T) ? true : false;
type AssertFalse<T extends false> = T;

const numbersJson = new ArraySchema<number>().toJSON();
const numbers: number[] = numbersJson;
type ArrayElementIsNotAny = AssertFalse<IsAny<typeof numbersJson[number]>>;
// @ts-expect-error - numeric JSON elements cannot be assigned to strings
const wrongNumbers: string[] = numbersJson;

const scoresJson = new MapSchema<number>().toJSON();
const scores: Record<string, number> = scoresJson;
type MapValueIsNotAny = AssertFalse<IsAny<typeof scoresJson[string]>>;
// @ts-expect-error - numeric JSON values cannot be assigned to strings
const wrongScores: Record<string, string> = scoresJson;
void numbers; void scores; void wrongNumbers; void wrongScores;

// Literal values remain values, including strings that name wire codecs.
const literalArray: ("number" | "string")[] = new ArraySchema<"number" | "string">().toJSON();
const literalMap: Record<string, "number" | "string"> = new MapSchema<"number" | "string">().toJSON();
// @ts-expect-error - a codec-named string value does not serialize as a number
const wrongLiteral: number[] = new ArraySchema<"number">().toJSON();
void literalArray; void literalMap; void wrongLiteral;

// Schema elements serialize to their data shape, without methods or machinery.
const playersJson = new ArraySchema<Player>().toJSON();
const playersByIdJson = new MapSchema<Player>().toJSON();
const players: ToJSON<Player>[] = playersJson;
const playersById: Record<string, ToJSON<Player>> = playersByIdJson;
const playerName: string = playersJson[0]!.name;
const playerHp: number = playersByIdJson["one"]!.hp;
// @ts-expect-error - serialized data does not contain class methods
playersJson[0]!.hit();
// @ts-expect-error - serialized data does not contain Schema machinery
playersByIdJson["one"]!.isTrackingPaused;
// @ts-expect-error - serialized data cannot be assigned to a Schema instance
const wrongPlayer: Player = playersJson[0]!;
void players; void playersById; void playerName; void playerHp; void wrongPlayer;

// Nested fields use the existing Schema JSON mapping recursively.
const statesJson = new ArraySchema<State>().toJSON();
const statesByIdJson = new MapSchema<State>().toJSON();
const nestedName: string = statesJson[0]!.list[0]!.name;
const nestedHp: number = statesByIdJson["one"]!.players["two"]!.hp;
// @ts-expect-error - nested serialized players do not expose methods
statesJson[0]!.players["one"]!.hit();
void nestedName; void nestedHp;

// Follow the actual toJSON override, rather than substituting the base shape.
const customArray = new ArraySchema<Custom>().toJSON();
const customMap = new MapSchema<Custom>().toJSON();
const arrayExtra: number = customArray[0]!.extra;
const mapExtra: number = customMap["one"]!.extra;
// @ts-expect-error - override output still does not contain class methods
customArray[0]!.hit();
void arrayExtra; void mapExtra;

// Mixed value types distribute; unconstrained collections keep their any API.
const mixed: (number | ToJSON<Player>)[] = new ArraySchema<number | Player>().toJSON();
const untypedArray: any[] = new ArraySchema().toJSON();
const untypedMap: Record<string, any> = new MapSchema().toJSON();
void mixed; void untypedArray; void untypedMap;

// Recursive collections must not introduce circular mapped-type errors.
class RecursiveNode extends Schema {
    name!: string;
    children = new ArraySchema<RecursiveNode>();
    byId = new MapSchema<RecursiveNode>();
}
const recursiveJson = new ArraySchema<RecursiveNode>().toJSON();
const recursiveName: string = recursiveJson[0]!.children[0]!.byId["one"]!.name;
void recursiveName;

// Collection annotations must preserve the existing native-collection interface.
interface NativeCollections extends Schema {
    players: Map<string, string>;
    items: string[];
}
class SchemaCollections extends Schema implements NativeCollections {
    players = new MapSchema<string>();
    items = new ArraySchema<string>();
}
abstract class TypedRoom<T extends NativeCollections> { }
class CollectionRoom extends TypedRoom<SchemaCollections> { }
void CollectionRoom;
