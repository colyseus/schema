import { schema, t, Schema, type SchemaType } from "../../build/index.js";

// `.extend()` must behave like class inheritance at the type level: the child
// is a subtype of the parent, sees every level's fields and methods, and its
// constructor requires what the chain requires.

const Entity = schema({
    x: t.number(),
    y: t.number(),
    hp: t.uint8().default(100),
    tag: t.string().optional(),
    dist() { return Math.hypot(this.x, this.y); },
}, "Entity");
type Entity = SchemaType<typeof Entity>;

const Player = Entity.extend({
    name: t.string(),
    describe() { return `${this.name}@${this.dist()} hp=${this.hp}`; },   // `this` sees the parent
}, "Player");
type Player = SchemaType<typeof Player>;

const Warrior = Player.extend({ weapon: t.string().default("fists") }, "Warrior");
type Warrior = SchemaType<typeof Warrior>;

// every level's members, with the parent's optionality preserved
declare const w: Warrior;
const members: [number, number, string, string, number, string] = [w.x, w.hp, w.name, w.weapon, w.dist(), w.describe()];
const tag: string | undefined = w.tag;
void members; void tag;
// @ts-expect-error — optional stays optional through extend
const tagNarrow: string = w.tag;
void tagNarrow;

// subtype relation runs one way
const asPlayer: Player = w;
const asEntity: Entity = w;
void asPlayer; void asEntity;
// @ts-expect-error — a parent is not a child
const notPlayer: Player = (null as unknown as Entity);
void notPlayer;

// instanceof narrows to the right level
declare const some: Schema;
if (some instanceof Player) {
    const n: string = some.name;
    void n;
}
if (some instanceof Entity) {
    // @ts-expect-error — Entity has no `name`
    some.name;
}

// constructor: the whole chain's required fields, nothing else
new Warrior({ x: 1, y: 2, name: "n" });
new Warrior({ x: 1, y: 2, name: "n", hp: 5, tag: "t", weapon: "w" });
new Warrior();
// @ts-expect-error — parent's required fields missing
new Warrior({ name: "n" });
// @ts-expect-error — own required field missing
new Warrior({ x: 1, y: 2 });
// @ts-expect-error — unknown key
new Warrior({ x: 1, y: 2, name: "n", nope: 1 });

// toJSON / assign / restore / setDirty see inherited fields, not methods
const json = w.toJSON();
const jsonFields: [number, string, string] = [json.x, json.name, json.weapon];
void jsonFields;
// @ts-expect-error — methods are not in the JSON shape
json.dist;
w.assign({ x: 1, name: "n", weapon: "w" });
// @ts-expect-error — not a field
w.assign({ nope: 1 });
w.restore({ x: 1, y: 2, hp: 1, name: "n", weapon: "w" });
w.setDirty("x");
// @ts-expect-error — not a field
w.setDirty("dist");

// collections typed by the parent accept children
const State = schema({ entities: t.map(Entity), players: t.map(Player) });
declare const state: SchemaType<typeof State>;
state.entities.set("a", new Warrior({ x: 0, y: 0, name: "n" }));
// @ts-expect-error — a map of players cannot hold a plain entity
state.players.set("b", new Entity({ x: 0, y: 0 }));

// a generic over the parent keeps the child
function move<E extends Entity>(e: E): E { e.x++; return e; }
const moved: Warrior = move(w);
void moved;

// a native class can extend a schema() result — the constructor type's
// `prototype` must not declare members the instance lacks
class Boss extends Warrior {
    rage = 0;
    enrage() { this.rage++; this.hp--; return this.describe(); }
}
const boss = new Boss({ x: 0, y: 0, name: "b" });
const bossAsWarrior: Warrior = boss;
const bossEnrage: string = boss.enrage();
void bossAsWarrior; void bossEnrage;

// initialize(): inherited unless the child redefines it
const WithInit = schema({
    v: t.number(),
    initialize(opts: { v: number; scale: number }) { this.v = opts.v * opts.scale; },
}, "WithInit");
const Inherits = WithInit.extend({ extra: t.number() }, "Inherits");
new Inherits({ v: 1, scale: 2 });
// @ts-expect-error — the inherited initialize() owns the props
new Inherits({ v: 1 });
const Overrides = WithInit.extend({
    initialize(opts: { v: number }) { this.v = opts.v; },
}, "Overrides");
new Overrides({ v: 1 });
// @ts-expect-error — the override's signature replaces the parent's
new Overrides({ v: 1, scale: 2 });
// a parent method stays callable on the prototype for super-style calls
WithInit.prototype.initialize.call(null as unknown as SchemaType<typeof Overrides>, { v: 1, scale: 2 });

// a custom base survives extend
class Base extends Schema { helper() { return "h"; } }
const OnBase = schema({ w: t.number() }, "OnBase", Base);
const OnBaseChild = OnBase.extend({ q: t.number(), useIt() { return this.helper() + this.w + this.q; } }, "OnBaseChild");
declare const onBaseChild: SchemaType<typeof OnBaseChild>;
const helper: string = onBaseChild.helper();
const asBase: Base = onBaseChild;
void helper; void asBase;
