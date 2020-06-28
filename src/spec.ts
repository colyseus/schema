export const PUSH_STRUCTURE = 190;
export const POP_STRUCTURE = 191;
export const SWITCH_TO_STRUCTURE = 0xc1; // 193

export const NIL = 0xc0; // 192
export const INDEX_CHANGE = 0xd4; // 212
export const TYPE_ID = 0xd5; // 213

/**
 * Encoding Schema field operations.
 */
export enum OPERATION {
    // add new structure/primitive
    // (128)
    ADD = 128, // 10000000,

    // replace structure/primitive
    REPLACE = 1,// 00000001

    // delete field
    DELETE = 192, // 11000000

    // DELETE field, followed by an ADD
    DELETE_AND_ADD = 224, // 11100000

    // TOUCH is used to determine hierarchy of nested Schema structures during serialization.
    // touches are NOT encoded.
    TOUCH = 0, // 00000000

    // MapSchema Operations
    CLEAR = 10,
}