import {
    ArraySchema,
    CollectionSchema,
    Decoder,
    MapSchema,
    Reflection,
    Schema,
    SetSchema,
    StateCallbackStrategy,
    StreamSchema,
    getDecoderStateCallbacks,
    type,
} from "../../build/index.js";

// Every `@type({ ... })` form must resolve within TypeScript 7's
// instantiation-depth budget (TS2589).

class Child extends Schema {
    @type("string") id: string = "";
}

enum Color { Red = "red", Blue = "blue" }

class Annotated extends Schema {
    @type("string") str: string = "";
    @type("uint8") num: number = 0;
    @type(Child) ref = new Child();
    @type([Child]) shorthandArray = new ArraySchema<Child>();

    @type({ type: Child }) explicitRef = new Child();
    @type({ type: "number", default: 42 }) withDefault: number = 42;

    @type({ map: Child }) map = new MapSchema<Child>();
    @type({ array: Child }) array = new ArraySchema<Child>();
    @type({ set: Child }) set = new SetSchema<Child>();
    @type({ collection: Child }) collection = new CollectionSchema<Child>();
    @type({ stream: Child }) stream = new StreamSchema<Child>();

    @type({ map: "string" }) primitiveMap = new MapSchema<string>();
    @type({ array: "string" }) primitiveArray = new ArraySchema<string>();
    @type({ map: Color }) enumMap = new MapSchema<Color>();

    @type({ map: Child, view: true }) viewTagged = new MapSchema<Child>();
    @type({ map: Child, sync: false }) unsynced = new MapSchema<Child>();
}

declare const annotated: Annotated;
const annotatedMap: MapSchema<Child> = annotated.map;
const annotatedArray: ArraySchema<Child> = annotated.array;
const annotatedRef: Child = annotated.ref;
void annotatedMap; void annotatedArray; void annotatedRef;

// `Reflection.decode`, inferred and explicit
declare const bytes: Uint8Array;
const decoded: Decoder<Schema> = Reflection.decode(bytes);
const decodedAs: Decoder<Child> = Reflection.decode<Child>(bytes);
void decoded; void decodedAs;

// a field declared as a plain array (`@type([X]) items: X[]`) is still a
// collection to the decoder callbacks — both the `Callbacks` and `$()` styles
class WithPlainArrays extends Schema {
    @type(["int16"]) numbers: number[] = new ArraySchema<number>();
    @type([Child]) children: Child[] = new ArraySchema<Child>();
    @type({ map: Child }) byId = new MapSchema<Child>();
}
declare const plain: WithPlainArrays;
declare const callbacks: StateCallbackStrategy<WithPlainArrays>;
callbacks.onAdd("numbers", (value: number, key: number) => { void value; void key; });
callbacks.onAdd(plain, "children", (value: Child, key: number) => { void value; void key; });
callbacks.onRemove("byId", (value: Child, key: string) => { void value; void key; });
declare const plainDecoder: Decoder<WithPlainArrays>;
const $ = getDecoderStateCallbacks(plainDecoder);
$(plain).numbers.onAdd((value: number, key: number) => { void value; void key; });
$(plain).children.onAdd((value: Child, key: number) => { void value; void key; });
