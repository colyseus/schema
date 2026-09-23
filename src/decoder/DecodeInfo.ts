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
    /**
     * `true` when the slot is a primitive whose accessor is the generated
     * `$values`-backed one, so the decoder may read/write `values[index]`
     * directly instead of a dynamic `ref[name]` access (a megamorphic keyed
     * load + store through the tracked setter). Fields
     * declared `{ manual: true }` have no accessor and keep the named path.
     */
    direct: boolean[];
}

const $decodeInfo = Symbol.for("$decodeInfo");

/** Does `name` resolve to an accessor (getter) somewhere on the prototype chain? */
function hasAccessor(proto: any, name: string): boolean {
    for (let p = proto; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
        const d = Object.getOwnPropertyDescriptor(p, name);
        if (d !== undefined) return d.get !== undefined;
    }
    return false;
}

export function getDecodeInfo(ctor: any): DecodeInfo {
    let info: DecodeInfo | undefined = ctor[$decodeInfo];
    if (info !== undefined && Object.prototype.hasOwnProperty.call(ctor, $decodeInfo)) return info;
    const metadata = ctor[Symbol.metadata];
    const numFields: number = metadata?.[$numFields] ?? -1;
    const fields: any[] = [];
    const readers: DecodeInfo["readers"] = [];
    const direct: boolean[] = [];
    for (let i = 0; i <= numFields; i++) {
        const field = metadata[i];
        fields[i] = field;
        if (field === undefined) { readers[i] = undefined; direct[i] = false; continue; }
        const type = field.type;
        readers[i] = (typeof type === "string") ? (decode as any)[type]
            : isQuantizedType(type) ? (bytes: Uint8Array, it: any) => decodeQuantized(type.quantized, bytes, it)
            : undefined;
        direct[i] = readers[i] !== undefined && field.deprecated !== true && hasAccessor(ctor.prototype, field.name);
    }
    info = { fields, readers, direct };
    Object.defineProperty(ctor, $decodeInfo, { value: info, enumerable: false, writable: true, configurable: true });
    return info;
}
