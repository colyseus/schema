const primitive = {
    str: "Hello world!",
    bool: true,
    double: Math.random(),
    float: Math.random(),
    int32: 2147483647,
    uint32: 4294967295,
};
const primitiveEncoded = JSON.stringify(primitive);

export function encodePrimitiveTypes() {
    JSON.stringify(primitive);
}

export function decodePrimitiveTypes() {
    JSON.parse(primitiveEncoded);
}