// Real-world Colyseus room shapes + the server's per-tick call sequence.
//
// Every builder takes the imported library module (`lib`) so the same scenario
// runs unchanged against a 5.0.x build and a 6.0 build. Only APIs present on
// both are used here: Schema / MapSchema / ArraySchema, type() / view(),
// Encoder { encode, encodeView, encodeAll, encodeAllView, hasChanges,
// discardChanges, BUFFER_SIZE }, StateView { add, remove, has, changes },
// Decoder, Reflection, Callbacks.get.
//
// Shapes:
//   Arena     — State { players: Map<Player>, entities: Map<Entity> (@view), tick, phase }
//               Entity { x, y, vx, vy, rotation, hp, kind, name }  (numType: number | typed | quantized)
//   World     — Arena without @view + tiles: Tile[] + config: Config   (big-state full sync)
//   Lobby     — State { players: Map<LobbyPlayer>, messages: Message[], topic }
//   Rpg       — State { heroes: Map<Hero{ stats: Stats, inventory: Map<Item>, ... }> }
//   TurnBased — State { board: uint8[], currentTurn, players: Map<TBPlayer>, round }
//   Shard     — State { players: Map<Player{ public x/y/hp; @view() gold, inventory; @view(1) mana }>, zone }
import { KEY, setBufferSize, field, codecOf, withCodecs, encodeAllForView } from "./fixtures.mjs";

export { KEY, setBufferSize, field, codecOf, withCodecs, encodeAllForView };

/** Deterministic PRNG (mulberry32) — every build sees identical mutation streams. */
export function makeRng(seed = 0x9e3779b9) {
    let a = seed >>> 0;
    return function rng() {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Typed-map-key support (6.0 working tree); older builds stringify number keys. */
export function hasTypedKeys(lib) {
    return "~applyKeyType" in lib.MapSchema.prototype;
}

export function hasQuantized(lib) {
    return typeof lib.t?.quantized === "function";
}

// --- Number type presets ---------------------------------------------------
//
//   number    — what most user code declares ("number": fractional = 5 B, small int = 1 B)
//   typed     — float32 positions/velocities, int16 hp, uint8 kind (4 B / 2 B / 1 B)
//   quantized — 6.0 only: t.quantized({ min, max, bits }) positions (2 B each)

export const WORLD_SIZE = 3000;

function numTypes(lib, numType) {
    if (numType === "typed") {
        return { pos: "float32", vel: "float32", rot: "float32", hp: "int16", coord: "float32" };
    }
    if (numType === "quantized") {
        if (!hasQuantized(lib)) throw new Error("quantized variant needs a build with t.quantized");
        // raw `{ quantized: opts }` form: the decorator path (`type()`) normalizes
        // it; the `t.quantized()` builder is only unwrapped by `schema({...})`.
        return {
            pos: { quantized: { min: 0, max: WORLD_SIZE, bits: 16 } },
            vel: { quantized: { min: -8, max: 8, bits: 16 } },
            rot: { quantized: { min: 0, max: Math.PI * 2, mode: "wrap", bits: 16 } },
            hp: "int16",
            coord: { quantized: { min: 0, max: WORLD_SIZE, bits: 16 } },
        };
    }
    return { pos: "number", vel: "number", rot: "number", hp: "number", coord: "number" };
}

function mapDef(lib, child, keyType) {
    return (keyType === undefined || keyType === "string") ? { map: child } : { map: child, key: keyType };
}

/** Key factory honouring typed keys when the build has them (mirrors defineMapState). */
export function keyFactory(lib, keyType) {
    if (keyType === undefined || keyType === "string") return (i) => `e${i}`;
    return hasTypedKeys(lib) ? (i) => i : (i) => String(i);
}

// --- Arena (entities + AOI) ----------------------------------------------

/**
 * @param {object} opts
 * @param {"number"|"typed"|"quantized"} [opts.numType]
 * @param {boolean} [opts.nested]        x,y live in `position: Vec2` (Colyseus sample style)
 * @param {boolean} [opts.viewEntities]  `@view()` on State.entities (AOI pattern); default true
 * @param {"string"|"number"} [opts.keyType] map key type for entities (number = 6.0 typed keys)
 */
export function defineArena(lib, opts = {}) {
    const { numType = "number", nested = false, viewEntities = true, keyType = "string" } = opts;
    setBufferSize(lib);
    const T = numTypes(lib, numType);

    let Vec2;
    if (nested) {
        Vec2 = class Vec2 extends lib.Schema {};
        field(lib, Vec2, "x", T.pos);
        field(lib, Vec2, "y", T.pos);
    }

    class Entity extends lib.Schema {
        constructor() {
            super(...arguments);
            if (nested) this.position = new Vec2();
        }
    }
    if (nested) field(lib, Entity, "position", Vec2);
    else {
        field(lib, Entity, "x", T.pos);
        field(lib, Entity, "y", T.pos);
    }
    field(lib, Entity, "vx", T.vel);
    field(lib, Entity, "vy", T.vel);
    field(lib, Entity, "rotation", T.rot);
    field(lib, Entity, "hp", T.hp);
    field(lib, Entity, "kind", "uint8");
    field(lib, Entity, "name", "string");

    class Player extends lib.Schema {}
    field(lib, Player, "name", "string");
    field(lib, Player, "sessionId", "string");
    field(lib, Player, "x", T.coord);
    field(lib, Player, "y", T.coord);
    field(lib, Player, "score", "number");
    field(lib, Player, "connected", "boolean");

    class State extends lib.Schema {
        constructor() {
            super(...arguments);
            this.players = new lib.MapSchema();
            this.entities = new lib.MapSchema();
        }
    }
    field(lib, State, "players", { map: Player });
    field(lib, State, "entities", mapDef(lib, Entity, keyType), viewEntities ? true : undefined);
    field(lib, State, "tick", "number");
    field(lib, State, "phase", "string");

    return { State, Player, Entity, Vec2, nested, numType, key: keyFactory(lib, keyType) };
}

/** Position accessors that hide the nested/flat difference (hot path: two tiny functions). */
export function posAccessors(shapes) {
    return shapes.nested
        ? { getX: (e) => e.position.x, getY: (e) => e.position.y, setX: (e, v) => { e.position.x = v; }, setY: (e, v) => { e.position.y = v; } }
        : { getX: (e) => e.x, getY: (e) => e.y, setX: (e, v) => { e.x = v; }, setY: (e, v) => { e.y = v; } };
}

export function makeEntity(shapes, i, rng) {
    const e = new shapes.Entity();
    const acc = posAccessors(shapes);
    acc.setX(e, rng() * WORLD_SIZE);
    acc.setY(e, rng() * WORLD_SIZE);
    e.vx = (rng() * 6 - 3);
    e.vy = (rng() * 6 - 3);
    e.rotation = rng() * Math.PI * 2;
    e.hp = 100;
    e.kind = i % 7;
    e.name = `npc-${i}`;
    return e;
}

export function makePlayer(shapes, c, rng) {
    const p = new shapes.Player();
    p.name = `player ${c}`;
    p.sessionId = KEY(c);
    p.x = rng() * WORLD_SIZE;
    p.y = rng() * WORLD_SIZE;
    p.score = 0;
    p.connected = true;
    return p;
}

/**
 * Uniform grid used for area-of-interest. Clients are stationary; each one
 * subscribes to the 3×3 cells around its own cell. `subs[cell]` is the sorted
 * list of view indexes interested in that cell, so a crossing costs one merge
 * walk over two short arrays (no allocation).
 */
export class AoiGrid {
    constructor(size = WORLD_SIZE, cell = 300) {
        this.size = size;
        this.cell = cell;
        this.cols = Math.ceil(size / cell);
        this.cellCount = this.cols * this.cols;
        this.subs = [];
        for (let i = 0; i < this.cellCount; i++) this.subs.push([]);
        this.clientCell = [];
    }
    cellOf(x, y) {
        const cols = this.cols;
        let cx = (x / this.cell) | 0;
        let cy = (y / this.cell) | 0;
        if (cx < 0) cx = 0; else if (cx >= cols) cx = cols - 1;
        if (cy < 0) cy = 0; else if (cy >= cols) cy = cols - 1;
        return cy * cols + cx;
    }
    /** Place client `c` at a deterministic cell and subscribe it to the 3×3 neighbourhood. */
    placeClient(c) {
        const cell = (c * 7919) % this.cellCount;
        this.clientCell[c] = cell;
        const cols = this.cols;
        const cx = cell % cols, cy = (cell / cols) | 0;
        for (let dy = -1; dy <= 1; dy++) {
            const y = cy + dy;
            if (y < 0 || y >= cols) continue;
            for (let dx = -1; dx <= 1; dx++) {
                const x = cx + dx;
                if (x < 0 || x >= cols) continue;
                this.subs[y * cols + x].push(c); // clients placed in ascending order → sorted
            }
        }
        return cell;
    }
    /** Is client `c` interested in `cell`? */
    sees(c, cell) {
        const s = this.subs[cell];
        for (let i = 0; i < s.length; i++) if (s[i] === c) return true;
        return false;
    }
    /**
     * Entity moved from `oldCell` to `newCell`: remove it from views that only
     * saw the old cell, add it to views that only see the new one.
     */
    applyCellChange(views, entity, oldCell, newCell) {
        const a = this.subs[oldCell], b = this.subs[newCell];
        let i = 0, j = 0;
        while (i < a.length || j < b.length) {
            const va = i < a.length ? a[i] : Infinity;
            const vb = j < b.length ? b[j] : Infinity;
            if (va === vb) { i++; j++; continue; }
            if (va < vb) { views[va].remove(entity); i++; }
            else { views[vb].add(entity); j++; }
        }
    }
}

/**
 * Build an arena: `n` entities, `clients` StateViews (each `view.add(state)` +
 * the entities in its 3×3 cells). Returns everything the tick needs.
 */
export function buildArena(lib, codec, shapes, { n, clients, seed = 1 }) {
    const rng = makeRng(seed);
    const state = new shapes.State();
    const encoder = new codec.Encoder(state);
    const grid = new AoiGrid();
    const acc = posAccessors(shapes);

    const views = [];
    for (let c = 0; c < clients; c++) {
        const view = new lib.StateView();
        view.add(state);
        views.push(view);
        grid.placeClient(c);
        state.players.set(KEY(c), makePlayer(shapes, c, rng));
    }

    const entities = new Array(n);
    const cells = new Int32Array(n);
    for (let i = 0; i < n; i++) {
        const e = makeEntity(shapes, i, rng);
        entities[i] = e;
        state.entities.set(shapes.key(i), e);
        const cell = grid.cellOf(acc.getX(e), acc.getY(e));
        cells[i] = cell;
        const subs = grid.subs[cell];
        for (let s = 0; s < subs.length; s++) views[subs[s]].add(e);
    }
    return { state, encoder, views, entities, cells, grid, acc, rng };
}

/**
 * One simulation step: move `count` entities (all when omitted), bounce at the
 * edges, update AOI membership on cell crossings. Returns the number of crossings.
 */
export function moveEntities(arena, from, count, opts = {}) {
    const { entities, cells, grid, acc, views } = arena;
    const n = entities.length;
    const size = grid.size;
    const rotate = opts.rotate !== false;
    let crossings = 0;
    for (let k = 0; k < count; k++) {
        const i = (from + k) % n;
        const e = entities[i];
        let x = acc.getX(e) + e.vx;
        let y = acc.getY(e) + e.vy;
        if (x < 0) { x = -x; e.vx = -e.vx; } else if (x > size) { x = 2 * size - x; e.vx = -e.vx; }
        if (y < 0) { y = -y; e.vy = -e.vy; } else if (y > size) { y = 2 * size - y; e.vy = -e.vy; }
        acc.setX(e, x);
        acc.setY(e, y);
        if (rotate) e.rotation = (e.rotation + 0.01) % (Math.PI * 2);
        const cell = grid.cellOf(x, y);
        if (cell !== cells[i]) {
            grid.applyCellChange(views, e, cells[i], cell);
            cells[i] = cell;
            crossings++;
        }
    }
    return crossings;
}

// --- Server tick (SchemaSerializer.applyPatches) --------------------------

/**
 * Exactly what `SchemaSerializer.applyPatches` does per patch interval:
 * byte 0 is the protocol code (offset 1); with no state changes only views
 * with pending add/remove get a frame; otherwise one shared encode + one
 * encodeView per client into the same buffer, then discardChanges.
 * Returns the total bytes clients would receive (shared slice counted per client).
 */
export function serverTick(codec, encoder, views) {
    const it = { offset: 1 };
    let bytes = 0;
    if (!encoder.hasChanges) {
        for (let v = 0; v < views.length; v++) {
            const view = views[v];
            if (view.changes.size > 0) {
                bytes += codec.bytesOf(codec.encodeView(encoder, view, 1, it));
            }
        }
        encoder.discardChanges();
        return bytes;
    }
    encoder.encode(it);
    const sharedOffset = it.offset;
    if (views.length === 0) bytes = sharedOffset - 1; // no clients with views: the shared frame itself
    for (let v = 0; v < views.length; v++) {
        bytes += codec.bytesOf(codec.encodeView(encoder, views[v], sharedOffset, it));
    }
    encoder.discardChanges();
    return bytes;
}

/** Broadcast tick without views: one encode, every client gets the same bytes. */
export function serverTickShared(encoder, clients) {
    const it = { offset: 1 };
    if (!encoder.hasChanges) { encoder.discardChanges(); return 0; }
    const encoded = encoder.encode(it);
    encoder.discardChanges();
    return encoded.byteLength * clients;
}

/** Copy a `[shared, view]` pair (or a single slice) into one standalone frame. */
export function concatPair(payload) {
    if (!Array.isArray(payload)) return payload.slice();
    const [a, b] = payload;
    const out = new Uint8Array(a.byteLength + b.byteLength);
    out.set(a, 0);
    out.set(b, a.byteLength);
    return out;
}

/** Decoder for a view-client: Reflection handshake + full-sync for that view. */
export function makeViewClient(lib, codec, encoder, view) {
    const handshake = codec.Reflection.encode(encoder);
    const decoder = codec.Reflection.decode(handshake);
    decoder.decode(encodeAllForView(codec, encoder, view));
    return decoder;
}

/** Decoder for a full-state client (no view). */
export function makeFullClient(lib, codec, encoder) {
    const handshake = codec.Reflection.encode(encoder);
    const decoder = codec.Reflection.decode(handshake);
    decoder.decode(encoder.encodeAll());
    return decoder;
}

// --- World (big state) ------------------------------------------------------

export function defineWorld(lib, opts = {}) {
    const arena = defineArena(lib, { ...opts, viewEntities: false });

    class Tile extends lib.Schema {}
    field(lib, Tile, "type", "uint8");
    field(lib, Tile, "x", "uint16");
    field(lib, Tile, "y", "uint16");

    class Config extends lib.Schema {}
    field(lib, Config, "name", "string");
    field(lib, Config, "mode", "string");
    field(lib, Config, "maxPlayers", "uint8");
    field(lib, Config, "roundTime", "uint16");
    field(lib, Config, "gravity", "number");
    field(lib, Config, "friendlyFire", "boolean");
    field(lib, Config, "seed", "number");
    field(lib, Config, "version", "string");

    class State extends arena.State {
        constructor() {
            super(...arguments);
            this.tiles = new lib.ArraySchema();
            this.config = new Config();
        }
    }
    field(lib, State, "tiles", [Tile]);
    field(lib, State, "config", Config);

    return { ...arena, State, Tile, Config };
}

/** `n` entities, `players` players, `tiles` tiles; no views. */
export function buildWorld(lib, codec, shapes, { n, players = 100, tiles = 2000, seed = 1 }) {
    const rng = makeRng(seed);
    const state = new shapes.State();
    const encoder = new codec.Encoder(state);
    state.config.name = "big-world";
    state.config.mode = "deathmatch";
    state.config.maxPlayers = 200;
    state.config.roundTime = 600;
    state.config.gravity = 9.81;
    state.config.friendlyFire = false;
    state.config.seed = seed;
    state.config.version = "1.2.3";
    state.tick = 0;
    state.phase = "playing";
    for (let c = 0; c < players; c++) state.players.set(KEY(c), makePlayer(shapes, c, rng));
    const entities = new Array(n);
    for (let i = 0; i < n; i++) {
        const e = makeEntity(shapes, i, rng);
        entities[i] = e;
        state.entities.set(shapes.key(i), e);
    }
    for (let t = 0; t < tiles; t++) {
        const tile = new shapes.Tile();
        tile.type = t % 12;
        tile.x = t % 64;
        tile.y = (t / 64) | 0;
        state.tiles.push(tile);
    }
    return { state, encoder, entities, rng };
}

// --- Lobby / chat ------------------------------------------------------------

export function defineLobby(lib) {
    setBufferSize(lib);
    class LobbyPlayer extends lib.Schema {}
    field(lib, LobbyPlayer, "name", "string");
    field(lib, LobbyPlayer, "ready", "boolean");
    field(lib, LobbyPlayer, "avatar", "uint8");
    field(lib, LobbyPlayer, "ping", "uint16");

    class Message extends lib.Schema {}
    field(lib, Message, "from", "string");
    field(lib, Message, "text", "string");
    field(lib, Message, "ts", "number");

    class State extends lib.Schema {
        constructor() {
            super(...arguments);
            this.players = new lib.MapSchema();
            this.messages = new lib.ArraySchema();
        }
    }
    field(lib, State, "players", { map: LobbyPlayer });
    field(lib, State, "messages", [Message]);
    field(lib, State, "topic", "string");
    return { State, LobbyPlayer, Message };
}

const LOREM = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua";

export function chatText(rng, minLen = 40, maxLen = 120) {
    const len = minLen + ((rng() * (maxLen - minLen)) | 0);
    let s = "";
    while (s.length < len) s += LOREM.slice((rng() * 40) | 0, 40 + ((rng() * 60) | 0)) + " ";
    return s.slice(0, len);
}

export function buildLobby(lib, codec, shapes, { players = 100, history = 50, seed = 1 }) {
    const rng = makeRng(seed);
    const state = new shapes.State();
    const encoder = new codec.Encoder(state);
    state.topic = "general";
    const list = [];
    for (let c = 0; c < players; c++) {
        const p = new shapes.LobbyPlayer();
        p.name = `user-${c}`;
        p.ready = false;
        p.avatar = c % 32;
        p.ping = 20 + c;
        state.players.set(KEY(c), p);
        list.push(p);
    }
    for (let m = 0; m < history; m++) state.messages.push(makeMessage(shapes, rng, m));
    return { state, encoder, players: list, rng, history };
}

export function makeMessage(shapes, rng, i) {
    const msg = new shapes.Message();
    msg.from = `user-${(rng() * 100) | 0}`;
    msg.text = chatText(rng);
    msg.ts = 1_700_000_000_000 + i * 1000;
    return msg;
}

// --- RPG inventory -------------------------------------------------------------

export function defineRpg(lib) {
    setBufferSize(lib);
    class Stats extends lib.Schema {}
    field(lib, Stats, "str", "uint8");
    field(lib, Stats, "dex", "uint8");
    field(lib, Stats, "int", "uint8");
    field(lib, Stats, "vit", "uint8");

    class Item extends lib.Schema {}
    field(lib, Item, "id", "uint16");
    field(lib, Item, "qty", "uint8");
    field(lib, Item, "quality", "uint8");

    class Hero extends lib.Schema {
        constructor() {
            super(...arguments);
            this.stats = new Stats();
            this.inventory = new lib.MapSchema();
        }
    }
    field(lib, Hero, "name", "string");
    field(lib, Hero, "level", "uint8");
    field(lib, Hero, "hp", "int16");
    field(lib, Hero, "mp", "int16");
    field(lib, Hero, "stats", Stats);
    field(lib, Hero, "inventory", { map: Item });
    field(lib, Hero, "x", "number");
    field(lib, Hero, "y", "number");

    class State extends lib.Schema {
        constructor() {
            super(...arguments);
            this.heroes = new lib.MapSchema();
        }
    }
    field(lib, State, "heroes", { map: Hero });
    return { State, Hero, Item, Stats };
}

export function makeItem(shapes, rng, id) {
    const item = new shapes.Item();
    item.id = id;
    item.qty = 1 + ((rng() * 20) | 0);
    item.quality = (rng() * 5) | 0;
    return item;
}

export function buildRpg(lib, codec, shapes, { heroes = 200, items = 20, seed = 1 }) {
    const rng = makeRng(seed);
    const state = new shapes.State();
    const encoder = new codec.Encoder(state);
    const list = [];
    for (let h = 0; h < heroes; h++) {
        const hero = new shapes.Hero();
        hero.name = `hero-${h}`;
        hero.level = 1 + (h % 60);
        hero.hp = 500;
        hero.mp = 200;
        hero.stats.str = 10; hero.stats.dex = 10; hero.stats.int = 10; hero.stats.vit = 10;
        hero.x = rng() * WORLD_SIZE;
        hero.y = rng() * WORLD_SIZE;
        for (let i = 0; i < items; i++) hero.inventory.set(`slot${i}`, makeItem(shapes, rng, 1000 + i));
        state.heroes.set(KEY(h), hero);
        list.push(hero);
    }
    return { state, encoder, heroes: list, rng, items };
}

/**
 * One RPG tick: every hero moves, 10 take damage / spend mana, 5 gain an item,
 * 5 lose one, 2 get their Stats replaced (ref swap), 1 levels up.
 */
export function rpgTick(ctx, i) {
    const { heroes, rng, items, shapes } = ctx;
    const n = heroes.length;
    for (let h = 0; h < n; h++) {
        const hero = heroes[h];
        hero.x += 0.5;
        hero.y -= 0.25;
    }
    for (let k = 0; k < 10; k++) {
        const hero = heroes[(i * 10 + k) % n];
        hero.hp = 500 - ((i + k) % 400);
        hero.mp = 200 - ((i * 3 + k) % 150);
    }
    // 5 heroes (re)gain a slot, 5 others lose one of their original slots;
    // the rotation re-adds a lost slot later, so inventories stay ~20 items.
    for (let k = 0; k < 5; k++) {
        const hero = heroes[(i * 5 + k) % n];
        hero.inventory.set(`slot${(i + k) % items}`, makeItem(shapes, rng, 2000 + i));
    }
    for (let k = 0; k < 5; k++) {
        const hero = heroes[(i * 5 + k + 7) % n];
        hero.inventory.delete(`slot${(i + k) % items}`);
    }
    for (let k = 0; k < 2; k++) {
        const hero = heroes[(i * 2 + k + 13) % n];
        const stats = new shapes.Stats();
        stats.str = (i + k) & 0xff; stats.dex = 10; stats.int = 10; stats.vit = 10;
        hero.stats = stats;
    }
    heroes[i % n].level = 1 + (i % 60);
}

// --- Turn-based ---------------------------------------------------------------

export function defineTurnBased(lib) {
    setBufferSize(lib);
    class TBPlayer extends lib.Schema {}
    field(lib, TBPlayer, "name", "string");
    field(lib, TBPlayer, "score", "number");
    field(lib, TBPlayer, "connected", "boolean");

    class State extends lib.Schema {
        constructor() {
            super(...arguments);
            this.board = new lib.ArraySchema();
            this.players = new lib.MapSchema();
        }
    }
    field(lib, State, "board", ["uint8"]);
    field(lib, State, "currentTurn", "string");
    field(lib, State, "players", { map: TBPlayer });
    field(lib, State, "round", "uint16");
    return { State, TBPlayer };
}

export function buildTurnBased(lib, codec, shapes, { players = 4 }) {
    const state = new shapes.State();
    const encoder = new codec.Encoder(state);
    for (let i = 0; i < 64; i++) state.board.push(0);
    for (let c = 0; c < players; c++) {
        const p = new shapes.TBPlayer();
        p.name = `p${c}`;
        p.score = 0;
        p.connected = true;
        state.players.set(`p${c}`, p);
    }
    state.currentTurn = "p0";
    state.round = 1;
    return { state, encoder };
}

// --- Shard (owner-only fields) --------------------------------------------------

export function defineShard(lib) {
    setBufferSize(lib);
    class Item extends lib.Schema {}
    field(lib, Item, "id", "uint16");
    field(lib, Item, "qty", "uint8");

    class Player extends lib.Schema {
        constructor() {
            super(...arguments);
            this.inventory = new lib.MapSchema();
        }
    }
    field(lib, Player, "name", "string");
    field(lib, Player, "x", "number");
    field(lib, Player, "y", "number");
    field(lib, Player, "hp", "int16");
    field(lib, Player, "gold", "number", true);          // owner only
    field(lib, Player, "inventory", { map: Item }, true); // owner only
    field(lib, Player, "mana", "number", 1);             // party (tag 1)

    class State extends lib.Schema {
        constructor() {
            super(...arguments);
            this.players = new lib.MapSchema();
        }
    }
    field(lib, State, "players", { map: Player });
    field(lib, State, "zone", "string");
    return { State, Player, Item };
}

/**
 * `players` players; `clients` of them are connected with a StateView that
 * owns its own player (default tag) and sees 4 party mates with tag 1.
 */
export function buildShard(lib, codec, shapes, { players = 500, clients = 100, seed = 1 }) {
    const rng = makeRng(seed);
    const state = new shapes.State();
    const encoder = new codec.Encoder(state);
    state.zone = "forest";
    // Views bind to the root BEFORE any player exists: `view.add(state)` on a
    // populated state marks the whole subtree visible (every player's
    // owner-only fields to every client), which is not the shard contract.
    const views = [];
    for (let c = 0; c < clients; c++) {
        const view = new lib.StateView();
        view.add(state);
        views.push(view);
    }
    const list = [];
    for (let p = 0; p < players; p++) {
        const player = new shapes.Player();
        player.name = `p${p}`;
        player.x = rng() * WORLD_SIZE;
        player.y = rng() * WORLD_SIZE;
        player.hp = 100;
        player.gold = 50;
        player.mana = 30;
        for (let i = 0; i < 8; i++) {
            const item = new shapes.Item();
            item.id = 100 + i;
            item.qty = 1;
            player.inventory.set(`s${i}`, item);
        }
        state.players.set(KEY(p), player);
        list.push(player);
    }
    for (let c = 0; c < clients; c++) {
        const view = views[c];
        view.add(list[c]);                  // own player: default tag → gold + inventory
        for (let m = 1; m <= 4; m++) {      // party: mana only
            view.add(list[(c + m) % players], 1);
        }
    }
    return { state, encoder, players: list, views, rng };
}

/** Attach the idiomatic client listeners; returns counters to assert in teardown. */
export function attachCallbacks(lib, decoder, spec) {
    const $ = lib.Callbacks.get(decoder);
    const counters = { onAdd: 0, onRemove: 0, listen: 0 };
    for (const [collection, fields] of Object.entries(spec)) {
        $.onAdd(collection, (item) => {
            counters.onAdd++;
            for (const f of fields) $.listen(item, f, () => { counters.listen++; });
        });
        $.onRemove(collection, () => { counters.onRemove++; });
    }
    return counters;
}
