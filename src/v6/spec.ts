/**
 * v6 wire format constants.
 *
 * Framing: a message is a sequence of `uvarint(refId) uvarint(byteLen) ops`
 * chunks. No reserved byte — the decoder skips unknown refIds exactly.
 */
export const PROTOCOL_VERSION = 6;

/** Low bits of a ref value header: `uvarint(refId * 4 + flags)`. */
export const REF_HAS_TYPE = 1;
export const REF_HAS_BODY = 2;

/**
 * Schema field ops are packed as `uvarint(fieldIndex << 2 | op2)` where `op2`
 * is the v5 OPERATION's top two bits (`op >>> 6`): REPLACE 0, DELETE 1,
 * ADD 2, DELETE_AND_ADD 3. Collection ops keep the v5 OPERATION byte
 * (`u8 op, uvarint(index | refId), value?`).
 */

/** Structure kinds. Map/Array coincide with `CollectionKind`; Set/Collection/Stream share the indexed layout. */
export const KIND_SCHEMA = 0;
export const KIND_MAP = 1;
export const KIND_ARRAY = 2;
export const KIND_INDEXED = 3;
