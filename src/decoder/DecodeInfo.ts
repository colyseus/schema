import { decode } from "../encoding/decode.js";
import { decodeQuantized, isQuantizedType } from "../types/quantize.js";
import { $numFields } from "../types/symbols.js";

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
}

const $decodeInfo = Symbol.for("$decodeInfo");

export function getDecodeInfo(ctor: any): DecodeInfo {
    let info: DecodeInfo | undefined = ctor[$decodeInfo];
    if (info !== undefined && Object.prototype.hasOwnProperty.call(ctor, $decodeInfo)) return info;
    const metadata = ctor[Symbol.metadata];
    const numFields: number = metadata?.[$numFields] ?? -1;
    const fields: any[] = [];
    const readers: DecodeInfo["readers"] = [];
    for (let i = 0; i <= numFields; i++) {
        const field = metadata[i];
        fields[i] = field;
        if (field === undefined) { readers[i] = undefined; continue; }
        const type = field.type;
        readers[i] = (typeof type === "string") ? (decode as any)[type]
            : isQuantizedType(type) ? (bytes: Uint8Array, it: any) => decodeQuantized(type.quantized, bytes, it)
            : undefined;
    }
    info = { fields, readers };
    Object.defineProperty(ctor, $decodeInfo, { value: info, enumerable: false, writable: true, configurable: true });
    return info;
}
