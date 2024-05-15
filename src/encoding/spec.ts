export const SWITCH_TO_STRUCTURE = 255; // (decoding collides with DELETE_AND_ADD + fieldIndex = 63)
export const TYPE_ID = 213;

/**
 * Encoding Schema field operations.
 */
export enum OPERATION {
    ADD = 128,            // (10000000) add new structure/primitive
    REPLACE = 0,          // (00000001) replace structure/primitive
    DELETE = 64,          // (01000000) delete field
    DELETE_AND_ADD = 192, // (11000000) DELETE field, followed by an ADD

    /**
     * Collection operations
     */
    CLEAR = 10,

    /**
     * ArraySchema operations
     */
    PUSH = 11,
    UNSHIFT = 12,
    REVERSE = 15,

}
