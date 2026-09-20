/**
 * Wire format v6.
 *
 * Framing: a message is a sequence of `uvarint(refId) uvarint(byteLen) ops`
 * chunks. There is no reserved byte — a decoder that does not know a refId
 * skips exactly `byteLen` bytes.
 */
export const PROTOCOL_VERSION = 6;

/**
 * Schema field operations and keyed-collection (Map / Set / Stream)
 * operations. Also the vocabulary of `DataChange.op` on the decoder side —
 * array ops are translated into these when callbacks are dispatched.
 *
 * Schema fields pack as `uvarint(fieldIndex << 2 | op >>> 6)`; keyed
 * collections write the byte verbatim: `u8 op, uvarint(index), [key], value?`.
 */
export enum OPERATION {
    ADD = 128,            // (10000000) add new structure/primitive
    REPLACE = 0,          // (00000000) replace structure/primitive
    DELETE = 64,          // (01000000) delete field
    DELETE_AND_ADD = 192, // (11000000) DELETE field, followed by an ADD

    /**
     * Collection operations
     */
    CLEAR = 10,
}

/**
 * Keyed-collection operations (Map / Set / Collection / Stream). A keyed op
 * is `uvarint(index * 4 + op) [key] value?` — two op bits, so an index below
 * 32 costs one byte and one below 8192 two. `REPLACE` / `DELETE` / `ADD` are
 * the Schema `op2` codes; `DELETE_AND_ADD` is not on the wire: an `ADD` onto
 * an index that holds a different value is a replacement, and the decoder
 * releases the previous value (the recorder still merges to `DELETE_AND_ADD`,
 * the emitter writes it as `ADD`). `CLEAR` is the lone byte `0x03`, always
 * the first op of its chunk. The key rides only on MapSchema `ADD` ops,
 * encoded per the map's declared key type.
 *
 * A `const` object (not a TS `enum`) for the same codegen reason as `ARRAY_OP`.
 */
export const KEYED_OP = {
    REPLACE: 0,
    DELETE: 1,
    ADD: 2,
    CLEAR: 3,
} as const;
export type KEYED_OP = typeof KEYED_OP[keyof typeof KEYED_OP];

/** `OPERATION >>> 6` → keyed op code: REPLACE, DELETE, ADD, and DELETE_AND_ADD written as ADD. */
export const KEYED_OP_CODE: readonly number[] = [KEYED_OP.REPLACE, KEYED_OP.DELETE, KEYED_OP.ADD, KEYED_OP.ADD];

/**
 * Key types a MapSchema may declare (`@type({ map: X, key: "number" })`).
 * The key writer / reader is the primitive table entry of the same name;
 * `"string"` is the default.
 */
export const MAP_KEY_TYPES: ReadonlySet<string> = new Set([
    "string", "number",
    "int8", "uint8", "int16", "uint16", "int32", "uint32", "int64", "uint64",
    "float32", "float64",
]);

/**
 * ArraySchema operations. An array chunk is `arrayOp*`; each
 * op advances the array's revision by its weight (see `encoder/ArrayLog.ts`).
 *
 * A `const` object rather than a TS `enum` on purpose: the codegen parser
 * emits every `EnumDeclaration` it finds in the library sources for the other
 * language targets, and this vocabulary is not part of their generated types.
 */
// arrayOp := uvarint(arg * 16 + op) operands...  (arg: the op's first operand, 0 when it has none)
export const ARRAY_OP = {
    PUSH: 1,        // arg count            value*                   weight count
    INSERT: 2,      // arg index            uvarint(count) value*    weight count
    SET: 3,         // arg index            value                    weight 1
    REMOVE: 4,      // arg index            uvarint(count)           weight count
    REVERSE: 5,     //                                               weight 1
    REORDER: 6,     // arg len              uvarint(oldPos)*len      weight 1
    RESTATE: 7,     // arg rev*2+identity   uvarint(count) value*    weight 1 (positional) / 0 (identity)
    ADD_REF: 8,     //                      refValue                 weight 0 (identity mode)
    DELETE_REF: 9,  // arg refId                                     weight 0 (identity mode)
    CLEAR: 10,      //                                               weight 1
    BASE: 11,       // arg baseSeq — the sequence the following ops apply at; sent only when a snapshot was taken this tick
} as const;
export type ARRAY_OP = typeof ARRAY_OP[keyof typeof ARRAY_OP];

/** Low bits of a ref value header: `uvarint(refId * 4 + flags)`. */
export const REF_HAS_TYPE = 1;
export const REF_HAS_BODY = 2;

/** Structure kinds (per class). Map/Array coincide with `CollectionKind`; Set/Collection/Stream share the indexed layout. */
export const KIND_SCHEMA = 0;
export const KIND_MAP = 1;
export const KIND_ARRAY = 2;
export const KIND_INDEXED = 3;

/**
 * Collection-kind discriminator declared on each collection class as
 * `static COLLECTION_KIND = CollectionKind.X`. A `const` object (not a TS
 * `enum`) for the same codegen reason as `ARRAY_OP`.
 */
export const CollectionKind = {
    Map: 1,
    Array: 2,
    Set: 3,
    Collection: 4,
    Stream: 5,
} as const;
export type CollectionKind = typeof CollectionKind[keyof typeof CollectionKind];
