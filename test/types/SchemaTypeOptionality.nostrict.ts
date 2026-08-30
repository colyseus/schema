import { schema, t, type SchemaType, type BuilderInitProps } from "../../build/index.js";

// Compiled with `strict: true` + `strictNullChecks: false` — the config
// create-colyseus-app generates. There `undefined extends V` is true for
// EVERY V, so any optionality read off the value type flips all fields
// optional; only the `.optional()` brand / `?` modifier can be trusted.
// This file fails against an implementation that reads the value type.

const Player = schema({ x: t.number(), y: t.number(), vx: t.number(), vy: t.number() });
declare const player: SchemaType<typeof Player>;

// an instance satisfies a plain required-field interface (shared step functions)
interface EntityState { x: number; y: number; vx: number; vy: number; }
function step(entity: EntityState) { void entity; }
step(player);

// toJSON keeps required keys required
const playerJSON: { x: number; y: number; vx: number; vy: number } = player.toJSON();
void playerJSON;

// `.optional()` still marks the property `?:` (value unions are collapsed here,
// so assert the modifier itself)
const Mixed = schema({ req: t.number(), opt: t.string().optional() });
declare const mixed: SchemaType<typeof Mixed>;
const mixedShape: { req: number } = mixed;
void mixedShape;
const optHasModifier: {} extends Pick<SchemaType<typeof Mixed>, "opt"> ? true : false = true;
void optHasModifier;
const optJSONHasModifier: {} extends Pick<ReturnType<SchemaType<typeof Mixed>["toJSON"]>, "opt"> ? true : false = true;
void optJSONHasModifier;

// init props keep their required/optional split
new Player({ x: 0, y: 0, vx: 0, vy: 0 });
// @ts-expect-error — required fields cannot be omitted at construction
new Player({ x: 0 });
new Mixed({ req: 1 });

// A key optional in the FIELDS MAP is still required at construction: KeyClass
// reads the builder brand, not the `?`, so the init-props mapping must strip a
// modifier it would otherwise inherit. Only reachable with strictNullChecks off.
declare const optKeyFields: { a: ReturnType<typeof t.number>; b?: ReturnType<typeof t.string> };
const initKeepsBRequired: {} extends Pick<BuilderInitProps<typeof optKeyFields>, "b"> ? false : true = true;
void initKeepsBRequired;
