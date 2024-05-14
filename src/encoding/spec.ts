export const SWITCH_TO_STRUCTURE = 255; // (decoding collides with DELETE_AND_ADD + fieldIndex = 63)
export const TYPE_ID = 213;

/**
 * Encoding Schema field operations.
 */
export enum OPERATION {
    // (10000000) add new structure/primitive
    ADD = 128,

    // (00000001) replace structure/primitive
    REPLACE = 0, //

    // (01000000) delete field
    DELETE = 64,

    // (11000000) DELETE field, followed by an ADD
    DELETE_AND_ADD = 192,

    // Custom Operations
    CLEAR = 10,
}
