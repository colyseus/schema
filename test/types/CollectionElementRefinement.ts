import { schema, t, Schema, ArraySchema, MapSchema, SetSchema, CollectionSchema, type SchemaType } from "../../build/index.js";

// Element refinement: `t.array<Mark>("uint8")` types the collection as
// `ArraySchema<Mark>` while the wire keeps the codec — the collection mirror of
// `t.uint8<Mark>()`. The refinement overload sits last, so bare calls must
// still infer from the child.

enum Mark { BLANK = 0, X = 1, O = 2 }
class Player extends Schema { }

// every collection factory carries the refinement, and the primitive factory
// it mirrors
const Every = schema({
    a: t.array<Mark>("uint8"),
    m: t.map<Mark>("uint8"),
    s: t.set<Mark>("uint8"),
    c: t.collection<Mark>("uint8"),
    team: t.array<"red" | "blue">("string"),
    one: t.uint8<Mark>(),
}, "RefinedEvery");
declare const every: SchemaType<typeof Every>;
const everyA: ArraySchema<Mark> = every.a;
const everyM: MapSchema<Mark> = every.m;
const everyS: SetSchema<Mark> = every.s;
const everyC: CollectionSchema<Mark> = every.c;
const everyTeam: ArraySchema<"red" | "blue"> = every.team;
const everyElem: Mark = every.a[0]!;
const everyOne: Mark = every.one;
void everyA; void everyM; void everyS; void everyC; void everyTeam; void everyElem; void everyOne;

// the refinement is checked against the codec it is paired with — `CodecFor`
// is derived from `InferValueType`, so it agrees with what the codec decodes
const Codecs = schema({
    wide: t.array<Mark>("int64"),        // int64 decodes to number, not bigint
    big: t.array<bigint>("biguint64"),
    bare: t.array("bigint64"),          // inferred, not refined
}, "RefinedCodecs");
declare const codecs: SchemaType<typeof Codecs>;
const codecsWide: ArraySchema<Mark> = codecs.wide;
const codecsBig: ArraySchema<bigint> = codecs.big;
const codecsBare: ArraySchema<bigint> = codecs.bare;
void codecsWide; void codecsBig; void codecsBare;

// @ts-expect-error — Mark is numeric, "string" cannot carry it
const BadCodec = schema({ board: t.array<Mark>("string") }, "RefinedBadCodec");
// @ts-expect-error — int64 decodes to number, so it cannot carry a bigint
const BadWidth = schema({ board: t.array<bigint>("int64") }, "RefinedBadWidth");
// @ts-expect-error — no codec decodes into a Schema instance
const BadRef = schema({ board: t.array<Player>("uint8") }, "RefinedBadRef");
void BadCodec; void BadWidth; void BadRef;

// bare calls keep inferring from the child — each guards one overload that
// sits ahead of the refinement
const Bare = schema({
    nums: t.array("uint8"),
    names: t.array("string"),
    players: t.array(Player),
}, "RefinedBare");
declare const bare: SchemaType<typeof Bare>;
const bareNums: number = bare.nums[0]!;
const bareNames: string = bare.names[0]!;
const barePlayers: Player = bare.players[0]!;
void bareNums; void bareNames; void barePlayers;
// @ts-expect-error — a string element must not read as a number
const bareWrong: number = bare.names[0]!;
void bareWrong;

// a free type parameter must not be captured as `any` during schema()'s
// self-referential field inference — `this` still sees concrete field types
const SelfRef = schema({
    hp: t.uint8(),
    board: t.array<Mark>("uint8"),
    alive() { return this.hp > 0 && this.board.length === 9; },
}, "RefinedSelfRef");
declare const selfRef: SchemaType<typeof SelfRef>;
const selfRefHp: number = selfRef.hp;
const selfRefAlive: boolean = selfRef.alive();
void selfRefHp; void selfRefAlive;
