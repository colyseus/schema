import { OPERATION } from "../../encoding/spec.js";
import { $changes, $track } from "../symbols.js";
import { registerType } from "../registry.js";
import { encode } from "../../encoding/encode.js";
import { decode, type Iterator } from "../../encoding/decode.js";
import type { Schema } from "../../Schema.js";

export type BitfieldFieldKind = "bool" | "uint";

export interface BitfieldFieldSpec {
    name: string;
    width: number;       // 1..32
    shift: number;       // 0..31
    mask: number;        // (1 << width) - 1
    kind: BitfieldFieldKind;
}

export interface BitfieldLayout {
    fields: BitfieldFieldSpec[];
    byteWidth: 1 | 2 | 4;
    totalBits: number;
    Class: typeof BitfieldValue;
    /** Pre-built encoder closure populated by createBitfieldClass. */
    encode: (bytes: any, value: BitfieldValue, it: Iterator) => void;
    /** Pre-built decoder closure populated by createBitfieldClass. */
    decode: (bytes: Uint8Array, it: Iterator) => BitfieldValue;
}

/** A wrapped bitfield-type tag, as produced by `t.bitfield(...)` and stored on `metadata[i].type`. */
export interface BitfieldType { bitfield: BitfieldLayout; }

/** Type guard: is `t` a `{ bitfield: BitfieldLayout }` wrapper? */
export function isBitfieldType(t: unknown): t is BitfieldType {
    return t !== null
        && typeof t === "object"
        && (t as any).bitfield !== undefined;
}

/**
 * Leaf value type holding a packed integer for a `t.bitfield(...)` group.
 * Not a Ref — no `$refId`, no `$changes` of its own. Sub-property writes
 * mark the owning Schema's parent slot dirty via `_markDirty()`.
 */
export class BitfieldValue {
    static layout: BitfieldLayout;

    _packed: number = 0;
    _parent: Schema | undefined = undefined;
    _parentIndex: number = -1;

    constructor(parent?: Schema, parentIndex?: number) {
        if (parent !== undefined) {
            this._parent = parent;
            this._parentIndex = parentIndex as number;
        }
    }

    /**
     * Apply a partial update from a plain object or another BitfieldValue.
     * Marks parent dirty when `_packed` actually changes.
     */
    assign(input: any): this {
        if (input == null) return this;
        const layout = (this.constructor as typeof BitfieldValue).layout;
        let packed = this._packed;

        if (input instanceof BitfieldValue) {
            packed = input._packed;
        } else {
            for (let i = 0; i < layout.fields.length; i++) {
                const f = layout.fields[i];
                if (input[f.name] === undefined) continue;
                const raw = f.kind === "bool"
                    ? (input[f.name] ? 1 : 0)
                    : (input[f.name] | 0);
                const fullMask = (f.mask << f.shift) >>> 0;
                packed = ((packed & ~fullMask) | ((raw & f.mask) << f.shift)) >>> 0;
            }
        }

        if (packed !== this._packed) {
            this._packed = packed;
            this._markDirty();
        }
        return this;
    }

    _markDirty(): void {
        const parent = this._parent;
        if (parent !== undefined) {
            const ctor = parent.constructor as any;
            ctor[$track](parent[$changes], this._parentIndex, OPERATION.ADD);
        }
    }

    clone(): BitfieldValue {
        const cls = this.constructor as typeof BitfieldValue;
        const out = new cls();
        out._packed = this._packed;
        return out;
    }

    toJSON(): { [name: string]: number | boolean } {
        const layout = (this.constructor as typeof BitfieldValue).layout;
        const out: any = {};
        const packed = this._packed;
        for (let i = 0; i < layout.fields.length; i++) {
            const f = layout.fields[i];
            const v = (packed >>> f.shift) & f.mask;
            out[f.name] = f.kind === "bool" ? v !== 0 : v;
        }
        return out;
    }
}

/**
 * Build a BitfieldValue subclass with prototype accessors for each sub-field.
 * Each unique `t.bitfield(...)` produces its own subclass to keep hidden
 * classes monomorphic per layout. Also pre-builds encode/decode closures
 * keyed off the layout's byte width.
 */
export function createBitfieldClass(layout: BitfieldLayout): typeof BitfieldValue {
    class C extends BitfieldValue {
        static layout: BitfieldLayout = layout;
    }
    layout.Class = C;

    for (let i = 0; i < layout.fields.length; i++) {
        const f = layout.fields[i];
        const shift = f.shift;
        const mask = f.mask;
        const isBool = f.kind === "bool";
        const fullMask = (mask << shift) >>> 0;
        const clearMask = (~fullMask) >>> 0;

        Object.defineProperty(C.prototype, f.name, {
            get(this: BitfieldValue) {
                const v = (this._packed >>> shift) & mask;
                return isBool ? v !== 0 : v;
            },
            set(this: BitfieldValue, value: any) {
                const raw = isBool ? (value ? 1 : 0) : (value | 0);
                const next = ((this._packed & clearMask) | ((raw & mask) << shift)) >>> 0;
                if (next !== this._packed) {
                    this._packed = next;
                    this._markDirty();
                }
            },
            enumerable: true,
            configurable: true,
        });
    }

    const w = layout.byteWidth;
    const enc = w === 1 ? encode.uint8 : w === 2 ? encode.uint16 : encode.uint32;
    const dec = w === 1 ? decode.uint8 : w === 2 ? decode.uint16 : decode.uint32;

    layout.encode = function (bytes, value, it) {
        enc(bytes, value._packed, it);
    };
    layout.decode = function (bytes, it) {
        const bf = new C();
        bf._packed = dec(bytes, it);
        return bf;
    };

    return C;
}

/**
 * Compute a {@link BitfieldLayout} from an ordered { name -> spec } record
 * where `spec` is `{ kind: "bool" }` or `{ kind: "uint", bits: N }`.
 */
export function buildBitfieldLayout(
    spec: { [name: string]: { kind: BitfieldFieldKind; bits?: number } },
): BitfieldLayout {
    const fields: BitfieldFieldSpec[] = [];
    let shift = 0;

    for (const name in spec) {
        const s = spec[name];
        let width: number;
        if (s.kind === "bool") {
            width = 1;
        } else if (s.kind === "uint") {
            width = s.bits as number;
            if (typeof width !== "number" || (width | 0) !== width || width < 1 || width > 32) {
                throw new Error(`t.bitfield: '${name}' uint width must be an integer in 1..32 (got ${width})`);
            }
        } else {
            throw new Error(`t.bitfield: '${name}' must be t.bool() or t.uint(n)`);
        }

        if (shift + width > 32) {
            throw new Error(`t.bitfield: total bits exceed 32 at field '${name}' (shift ${shift} + width ${width})`);
        }

        const mask = width === 32 ? 0xffffffff : ((1 << width) - 1);
        fields.push({ name, width, shift, mask, kind: s.kind });
        shift += width;
    }

    if (shift === 0) {
        throw new Error("t.bitfield: at least one sub-field is required");
    }
    const byteWidth: 1 | 2 | 4 = shift <= 8 ? 1 : shift <= 16 ? 2 : 4;

    return {
        fields,
        byteWidth,
        totalBits: shift,
        // Filled in by createBitfieldClass — placeholders here so the type
        // doesn't need narrowing at every read site.
        Class: BitfieldValue,
        encode: undefined as any,
        decode: undefined as any,
    };
}

// Register so getType("bitfield") routes through resolveFieldType. Per-field
// encode/decode are wired off `layout.encode` / `layout.decode` (see
// createBitfieldClass), not via this registry entry.
registerType("bitfield", { constructor: BitfieldValue });
