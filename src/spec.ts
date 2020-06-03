export const END_OF_STRUCTURE = 0xc1; // 193 (msgpack spec: never used)
export const NIL = 0xc0; // 192
export const INDEX_CHANGE = 0xd4; // 212
export const TYPE_ID = 0xd5; // 213

/**

Encoding Schema field indexes:

- First two bits are the OPERATION
- The least 6 bits are the field index (0-63)

     ↓ ↓ OPERATION
    +-+-+-+-+-+-+-+-+
    |0|0|0|0|0|0|0|0|
    +-+-+-+-+-+-+-+-+
         ↑ ↑ ↑ ↑ ↑ ↑ FIELD INDEX

*/
export enum OPERATION {
    ADD = parseInt("10000000", 2), // 128
    REPLACE = parseInt("00000000", 2), // 0
    DELETE = parseInt("11000000", 2) // 192
}