import { MapSchema, Schema, type } from "@colyseus/schema";

export class PrimitiveTypesMessage extends Schema {
    @type("string") str: string;
    @type("uint32") uint32: number;
    @type("int32") int32: number;
    @type("boolean") bool: boolean;
    @type("number") double: number;
    @type("float32") float: number;

}

export class ChildEmbeddedStructure extends Schema {
    @type("float32") x: number;
    @type("float32") y: number;
}

export class MapOfEmbeddedStructures extends Schema {
    @type({ map: ChildEmbeddedStructure }) mapOfEmbedded: MapSchema<ChildEmbeddedStructure>;
}