import { Schema, ArraySchema, MapSchema, type } from "../../build/index.js";

// Declaration shapes that have broken type-checking in the past. Compiled the
// way a create-colyseus-app server is: `strict: true` with `strictNullChecks`
// off, so fields may be declared without an initializer.

// `null` is assignable to a declared `number` field
class NullablePlayer extends Schema {
    @type("number") orderPriority: number;
}
declare const nullablePlayer: NullablePlayer;
nullablePlayer.assign({ orderPriority: null });

// a Schema class can implement an interface that extends Schema —
// MapSchema/ArraySchema stay compatible with Map/Array
interface SchemaInterface extends Schema {
    players: Map<string, string>;
    items: string[];
}

class SchemaInterfaceImpl extends Schema implements SchemaInterface {
    players: MapSchema<string>;
    items: ArraySchema<string>;
}

abstract class AbstractRoom<T extends SchemaInterface> { }
class AbstractRoomImpl extends AbstractRoom<SchemaInterfaceImpl> { }
void (null as unknown as AbstractRoomImpl);

// a generic subclass satisfies its base's constraint even when one of its
// fields is typed by its own type parameter — this reported "Type
// 'SpecialNode<E>' does not satisfy the constraint 'NodeBase'"
class Actions extends Schema {
    @type("string") actionTypes: string;
}

class NodeBase extends Schema {
    @type("string") id: string;
}

class TreeBase<N extends NodeBase> extends Schema {
    @type("string") id: string;
    @type([NodeBase]) nodes = new ArraySchema<N>();
}

class SpecialNode<E extends Actions> extends NodeBase {
    @type("string") type: string;
    @type(Actions) actions: E;
}

class SpecialTree<E extends Actions> extends TreeBase<SpecialNode<E>> {
    @type("string") user: string;
}
void (null as unknown as SpecialTree<Actions>);
