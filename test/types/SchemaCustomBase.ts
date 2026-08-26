import { schema, t, Schema, type SchemaType } from "../../build/index.js";

// A base passed as `schema()`'s third argument contributes its members to the
// instance, to `SchemaType<>`, and to `this` inside methods — all three agree.

class Base extends Schema {
    baseField: number = 0;
    helper(): string { return ""; }
}

const OnBase = schema({
    w: t.number(),
    useBase() { return this.helper(); },   // `this` sees the base's members too
}, "OnBase", Base);

// via the constructor
const built = new OnBase({ w: 1 });
const builtHelper: string = built.helper();
const builtBaseField: number = built.baseField;
const builtW: number = built.w;
void builtHelper; void builtBaseField; void builtW;

// via SchemaType<> — must agree with the constructor
declare const named: SchemaType<typeof OnBase>;
const namedHelper: string = named.helper();
const namedBaseField: number = named.baseField;
const namedW: number = named.w;
void namedHelper; void namedBaseField; void namedW;

// the two spellings are the same type
const namedFromBuilt: SchemaType<typeof OnBase> = built;
void namedFromBuilt;

// `.extend()` keeps the base's members
const Extended = OnBase.extend({ z: t.string() }, "Extended");
declare const extended: SchemaType<typeof Extended>;
const extendedHelper: string = extended.helper();
const extendedZ: string = extended.z;
const extendedW: number = extended.w;
void extendedHelper; void extendedZ; void extendedW;

// no base argument: still a plain Schema, and `t.ref()` to it resolves
const Plain = schema({ v: t.number() });
const Holder = schema({ inner: t.ref(Plain) });
declare const holder: SchemaType<typeof Holder>;
const holderInner: SchemaType<typeof Plain> = holder.inner;
const holderV: number = holder.inner.v;
void holderInner; void holderV;
