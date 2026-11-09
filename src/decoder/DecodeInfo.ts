import { decode } from "../encoding/decode.js";
import { decodeQuantized, isQuantizedType } from "../types/quantize.js";
import { $descriptors, $numFields } from "../types/symbols.js";
import { resolvesTo } from "../types/utils.js";
import type { RefInfo } from "./DecodeOperation.js";

/** How the decoder reaches a field — see `DecodeInfo.access`. */
export const ACCESS_NAMED = 0, ACCESS_DIRECT = 1, ACCESS_VALUES = 2;

/**
 * Per-class values the decoder needs: the field table by wire index and a
 * pre-resolved reader per primitive / quantized field (`undefined` for refs),
 * so the per-slot path is one array load instead of a string-keyed dispatch.
 * Cached on the constructor (own property — a subclass must not inherit its
 * parent's shorter table). Readers come from the live `decode` table, so
 * custom primitive types registered after import are honoured.
 */
export interface DecodeInfo {
    fields: any[];
    readers: (((bytes: Uint8Array, it: any) => any) | undefined)[];
    /**
     * Per field, whether the decoder may bypass the accessor. Behind the one
     * the library installed (`metadata[$descriptors]`) the value lives in
     * `values[index]` and the setter adds only validation and change
     * tracking, which decoding has no use for: a primitive takes
     * `decodeDirectSlot` (`ACCESS_DIRECT`), a ref is read and written in
     * `values` by `decodeSlot` (`ACCESS_VALUES`). `ACCESS_NAMED` otherwise —
     * `ref[name]` for deprecated and `{ manual: true }` fields, and to call a
     * user's accessor override.
     */
    access: number[];
    /** The class's shared decode record (`DecodeOperation.schemaRefInfo`), built on first use. */
    refInfo: RefInfo | undefined;
}

const $decodeInfo = Symbol.for("$decodeInfo");

/** Tiny on purpose (it inlines into `createRef`); the builder stays out of line. */
export function getDecodeInfo(ctor: any): DecodeInfo {
    const info: DecodeInfo | undefined = ctor[$decodeInfo];
    return (info !== undefined && Object.prototype.hasOwnProperty.call(ctor, $decodeInfo)) ? info : buildDecodeInfo(ctor);
}

function buildDecodeInfo(ctor: any): DecodeInfo {
    const metadata = ctor[Symbol.metadata];
    const numFields: number = metadata?.[$numFields] ?? -1;
    const fields: any[] = [];
    const readers: DecodeInfo["readers"] = [];
    const access: number[] = [];
    for (let i = 0; i <= numFields; i++) {
        const field = metadata[i];
        fields[i] = field;
        if (field === undefined) { readers[i] = undefined; access[i] = ACCESS_NAMED; continue; }
        const type = field.type;
        readers[i] = (typeof type === "string") ? (decode as any)[type]
            : isQuantizedType(type) ? (bytes: Uint8Array, it: any) => decodeQuantized(type.quantized, bytes, it)
            : undefined;
        access[i] = (field.deprecated === true || !resolvesTo(ctor.prototype, field.name, metadata[$descriptors]?.[field.name])) ? ACCESS_NAMED
            : (readers[i] !== undefined) ? ACCESS_DIRECT : ACCESS_VALUES;
    }
    const info: DecodeInfo = { fields, readers, access, refInfo: undefined };
    Object.defineProperty(ctor, $decodeInfo, { value: info, enumerable: false, writable: true, configurable: true });
    return info;
}
