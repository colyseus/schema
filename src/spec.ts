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
    ADD = parseInt("10000000", 2),

    // replace structure/primitive
    // (0)
    REPLACE = parseInt("00000000", 2),

    // delete field
    // (192)
    DELETE = parseInt("11000000", 2),

    // DELETE field, followed by an ADD
    // (224)
    DELETE_AND_ADD = parseInt("11100000", 2),

    // TOUCH is used to determine hierarchy of nested Schema structures during serialization.
    // touches are NOT encoded.
    // (1)
    TOUCH = parseInt("00000001", 2)
}