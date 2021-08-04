import { PrimitiveTypesMessage, MapOfEmbeddedStructures } from "./types";

const primitive = new PrimitiveTypesMessage();
primitive.str = "Hello world!";
primitive.bool = true;
primitive.double = Math.random();
primitive.float = Math.random();
primitive.int32 = 2147483647;
primitive.uint32 = 4294967295;

const primitiveEncoded = PrimitiveTypesMessage.encode(primitive).finish();

export function encodePrimitiveTypes() {
    PrimitiveTypesMessage.encode(primitive).finish();
}

export function decodePrimitiveTypes() {
    PrimitiveTypesMessage.decode(primitiveEncoded);
}