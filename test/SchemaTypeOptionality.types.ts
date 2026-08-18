import { schema, t, Schema, ArraySchema, MapSchema, type SchemaType } from "../build/index.js";

// Instance optionality must come from the `.optional()` brand, never from
// `undefined extends V`. The companion .nostrict file pins the same surface
// under `strictNullChecks: false`, where that idiom is true for every V.

// bare fields are required — an instance satisfies a plain structural interface
const Bare = schema({ x: t.number(), s: t.string() });
declare const bare: SchemaType<typeof Bare>;
const bareShape: { x: number; s: string } = bare;
const bareX: number = bare.x;
const bareIsSchema: Schema = bare;
void bareShape; void bareX; void bareIsSchema;

// `.default()` fields stay required on the instance — always present at runtime
const Defaulted = schema({ x: t.number().default(0) });
declare const defaulted: SchemaType<typeof Defaulted>;
const defaultedX: number = defaulted.x;
void defaultedX;

// `.optional()` fields admit undefined
const Optional = schema({ o: t.number().optional() });
declare const optional: SchemaType<typeof Optional>;
const optionalO: number | undefined = optional.o;
void optionalO;
// @ts-expect-error — must not collapse to plain number
const optionalONarrow: number = optional.o;
void optionalONarrow;

// the brand survives chaining in either order
const Chained = schema({ a: t.number().optional().default(1), b: t.number().default(1).optional() });
declare const chained: SchemaType<typeof Chained>;
const chainedA: number | undefined = chained.a;
const chainedB: number | undefined = chained.b;
void chainedA; void chainedB;

// a map mixing bare and `.optional()` fields must not leak optionality across keys
const Mixed = schema({ req: t.number(), opt: t.string().optional() });
declare const mixed: SchemaType<typeof Mixed>;
const mixedReq: number = mixed.req;
void mixedReq;
// @ts-expect-error — opt stays optional
const mixedOpt: string = mixed.opt;
void mixedOpt;

// collections auto-default, so they stay required on the instance
const Collections = schema({ items: t.array("number"), lookup: t.map("string") });
declare const collections: SchemaType<typeof Collections>;
const collectionsItems: ArraySchema<number> = collections.items;
const collectionsLookup: MapSchema<string> = collections.lookup;
void collectionsItems; void collectionsLookup;

// Schema refs auto-instantiate, so they stay required too
const Inner = schema({ v: t.number() });
const WithRef = schema({ inner: t.ref(Inner) });
declare const withRef: SchemaType<typeof WithRef>;
const withRefInner: SchemaType<typeof Inner> = withRef.inner;
const withRefV: number = withRef.inner.v;
void withRefInner; void withRefV;

// init props (BuilderInitProps) keep their own required/optional split
new Bare({ x: 1, s: "hi" });
// @ts-expect-error — x is required at construction
new Bare({ s: "hi" });
new Defaulted({});
new Optional({});
new Collections({});

// toJSON mirrors the instance split: bare required, `.optional()` optional
const bareJSON: { x: number; s: string } = bare.toJSON();
void bareJSON;
const mixedJSON = mixed.toJSON();
const mixedJSONReq: number = mixedJSON.req;
void mixedJSONReq;
// @ts-expect-error — opt stays optional in the JSON shape
const mixedJSONOpt: string = mixedJSON.opt;
void mixedJSONOpt;
