import { PrimitiveTypesMessage, MapOfEmbeddedStructures } from "./types";

const primitive = new PrimitiveTypesMessage();
primitive.str = "Hello world!";
primitive.bool = true;
primitive.double = Math.random();
primitive.float = Math.random();
primitive.int32 = 2147483647;
primitive.uint32 = 4294967295;
const primitiveEncoded = primitive.encodeAll();

export function encodePrimitiveTypes() {
    primitive.encodeAll();
}

const primitiveDecoder = new PrimitiveTypesMessage();
export function decodePrimitiveTypes() {
    primitiveDecoder.decode(primitiveEncoded);
}