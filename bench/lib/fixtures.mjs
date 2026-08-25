// Canonical schema shapes + state/frame builders, parameterized by the
// imported library module so the same scenario runs against any build snapshot.
//
// Shapes are byte-compatible with the historical benches:
//   Bloat — src/bench_bloat.ts  (State.players: Map<Player{name, position, scores[]}>)
//   Deep  — bench_view.js       (State→Player→Item→Attribute with @view() tags)

/** Deterministic 8-char key (replaces nanoid — removes randomness from fixtures). */
export const KEY = (i) => i.toString(36).padStart(8, "x");

/** Must run before constructing any Encoder — default 8KB overflows full-state encodes. */
export function setBufferSize(lib) {
    lib.Encoder.BUFFER_SIZE = 4 * 1024 * 1024;
}

// Decorators applied manually (same call shape __decorate produces): type first, then view.
function field(lib, Klass, name, typeDef, viewTag) {
    lib.type(typeDef)(Klass.prototype, name, undefined);
    if (viewTag !== undefined) {
        lib.view(viewTag === true ? undefined : viewTag)(Klass.prototype, name, undefined);
    }
}

// --- Bloat shape ---------------------------------------------------------

export function defineBloat(lib) {
    setBufferSize(lib);

    class Position extends lib.Schema {}
    field(lib, Position, "x", "number");
    field(lib, Position, "y", "number");

    class Player extends lib.Schema {
        constructor() {
            super(...arguments);
            this.position = new Position();
            this.scores = new lib.ArraySchema();
        }
    }
    field(lib, Player, "name", "string");
    field(lib, Player, "position", Position);
    field(lib, Player, "scores", ["number"]);

    class State extends lib.Schema {
        constructor() {
            super(...arguments);
            this.players = new lib.MapSchema();
        }
    }
    field(lib, State, "players", { map: Player });

    return { State, Player, Position };
}

export function makeBloatPlayer(Player, i) {
    const p = new Player();
    p.name = `Player ${i}`;
    p.position.x = i;
    p.position.y = i;
    for (let j = 0; j < 5; j++) p.scores.push(j);
    return p;
}

/** State + Encoder populated with n players keyed p0..p{n-1}. */
export function buildBloatState(lib, n = 1000) {
    const shapes = defineBloat(lib);
    const state = new shapes.State();
    const encoder = new lib.Encoder(state);
    for (let i = 0; i < n; i++) {
        state.players.set(`p${i}`, makeBloatPlayer(shapes.Player, i));
    }
    return { state, encoder, ...shapes };
}

/**
 * Heavy steady-state frames: every player x++/y++/scores[0]=i per tick.
 * Pre-generate outside any timed region (pattern from src/bench_decode_mem.ts).
 */
export function genHeavyFrames(state, encoder, ticks, n) {
    const frames = [];
    for (let i = 0; i < ticks; i++) {
        for (let j = 0; j < n; j++) {
            const p = state.players.get(`p${j}`);
            p.position.x++;
            p.position.y++;
            p.scores[0] = i;
        }
        frames.push(encoder.encode().slice());
        encoder.discardChanges();
    }
    return frames;
}

/**
 * Churn frames: each tick deletes `churn` players then re-adds fresh ones
 * (rotating window over n keys). Exercises ADD/DELETE ops, ref GC, and
 * decoder instance creation. Two frames per cycle (delete-frame, add-frame).
 */
export function genChurnFrames(lib, Player, state, encoder, cycles, n, churn) {
    const frames = [];
    for (let i = 0; i < cycles; i++) {
        for (let j = 0; j < churn; j++) state.players.delete(`p${(i * churn + j) % n}`);
        frames.push(encoder.encode().slice());
        encoder.discardChanges();
        for (let j = 0; j < churn; j++) {
            const key = `p${(i * churn + j) % n}`;
            state.players.set(key, makeBloatPlayer(Player, i * churn + j));
        }
        frames.push(encoder.encode().slice());
        encoder.discardChanges();
    }
    return frames;
}

// --- Deep shape (view-tagged) --------------------------------------------

export function defineDeep(lib) {
    setBufferSize(lib);

    class Attribute extends lib.Schema {}
    field(lib, Attribute, "name", "string");
    field(lib, Attribute, "value", "number");
    field(lib, Attribute, "secret", "string", true);

    class Item extends lib.Schema {
        constructor() {
            super(...arguments);
            this.attributes = new lib.ArraySchema();
        }
    }
    field(lib, Item, "price", "number");
    field(lib, Item, "attributes", [Attribute]);
    field(lib, Item, "cooldown", "number", true);
    field(lib, Item, "ownerSecret", "string", true);

    class Position extends lib.Schema {}
    field(lib, Position, "x", "number");
    field(lib, Position, "y", "number");

    class Player extends lib.Schema {
        constructor() {
            super(...arguments);
            this.position = new Position();
            this.items = new lib.MapSchema();
        }
    }
    field(lib, Player, "position", Position);
    field(lib, Player, "name", "string");
    field(lib, Player, "items", { map: Item });
    field(lib, Player, "privateGold", "number", true);
    field(lib, Player, "secretInventory", "string", true);

    class State extends lib.Schema {
        constructor() {
            super(...arguments);
            this.players = new lib.MapSchema();
        }
    }
    field(lib, State, "players", { map: Player });
    field(lib, State, "currentTurn", "string");
    field(lib, State, "adminSecret", "string", true);

    return { State, Player, Item, Attribute, Position };
}

/** One fully-populated Deep player (10 items × 5 attributes), as bench_view.js builds them. */
export function makeDeepPlayer(shapes, j) {
    const player = new shapes.Player();
    player.position.x = (j + 1) * 100;
    player.position.y = (j + 1) * 100;
    player.privateGold = (j + 1) * 7;
    player.secretInventory = `inv-${j}`;
    for (let k = 0; k < 10; k++) {
        const item = new shapes.Item();
        item.price = (j + 1) * 50;
        item.cooldown = k;
        item.ownerSecret = `sec-${k}`;
        for (let l = 0; l < 5; l++) {
            const attr = new shapes.Attribute();
            attr.name = `Attribute ${l}`;
            attr.value = l;
            attr.secret = `s-${l}`;
            item.attributes.push(attr);
        }
        player.items.set(`item-${k}`, item);
    }
    return player;
}

// --- Multi-view encode (mirrors test/Schema.ts encodeMultiple) ------------

/**
 * One tick for N views: shared encode + per-view encodeView.
 * Returns total encoded bytes across views (correctness guard metric).
 */
export function tickViews(encoder, views) {
    const it = { offset: 0 };
    encoder.encode(it);
    const sharedOffset = it.offset;
    let bytes = 0;
    for (let v = 0; v < views.length; v++) {
        bytes += encoder.encodeView(views[v], sharedOffset, it).byteLength;
    }
    encoder.discardChanges();
    return bytes;
}

/** Full-sync bytes for one view (client join): encodeAll + encodeAllView. */
export function encodeAllForView(encoder, view) {
    const it = { offset: 0 };
    encoder.encodeAll(it);
    return encoder.encodeAllView(view, it.offset, it);
}
