import { pack, unpack } from "msgpackr";

const primitive = {
    str: "Hello world!",
    bool: true,
    double: Math.random(),
    float: Math.random(),
    int32: 2147483647,
    uint32: 4294967295,
};
const primitiveEncoded = pack(primitive);

export function encodePrimitiveTypes() {
    pack(primitive);
}

export function decodePrimitiveTypes() {
    unpack(primitiveEncoded);
}
