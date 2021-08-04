import * as msgpack from "notepack.io";

const primitive = {
    str: "Hello world!",
    bool: true,
    double: Math.random(),
    float: Math.random(),
    int32: 2147483647,
    uint32: 4294967295,
};
const primitiveEncoded = msgpack.encode(primitive);

export function encodePrimitiveTypes() {
    msgpack.encode(primitive);
}

export function decodePrimitiveTypes() {
    msgpack.decode(primitiveEncoded);
}