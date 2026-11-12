// Differential fuzz for encoder changes that must not alter what clients
// decode (emission order, chunk grouping, caches): one seeded op stream —
// nested Schemas, instances shared between maps, detach / re-attach, `@view`
// maps with three StateViews, arrays — runs through two builds, and every
// client of both must hold the same state after every tick.
//
//   node bench/lib/fuzz-diff.mjs <buildA> <buildB> [seeds=40] [ticks=60]
//   OFF=views,secret,share,reattach,replace,list   switch op families off
//
// "decoder warnings" counts console.warn/error of both sides. With `reattach`
// on, the base build itself warns ("refId not found"): an instance of a
// `@view` map that gains a public parent reaches clients as an empty shell,
// and the two builds may then differ in which of its fields are missing.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { makeRng, field, encodeAllForView } from "./realworld.mjs";

const [dirA, dirB, seedsArg, ticksArg] = process.argv.slice(2);
const OFF = new Set((process.env.OFF ?? '').split(',').filter(Boolean));
const SEEDS = +(seedsArg ?? 40), TICKS = +(ticksArg ?? 60), CLIENTS = 3;

function world(lib) {
    class Vec2 extends lib.Schema {}
    field(lib, Vec2, "x", "number"); field(lib, Vec2, "y", "number");
    class Unit extends lib.Schema { constructor() { super(); this.pos = new Vec2(); this.vel = new Vec2(); } }
    field(lib, Unit, "pos", Vec2); field(lib, Unit, "vel", Vec2);
    field(lib, Unit, "hp", "number"); field(lib, Unit, "name", "string");
    field(lib, Unit, "secret", "number", true);
    class State extends lib.Schema { constructor() { super(); this.units = new lib.MapSchema(); this.mirror = new lib.MapSchema(); this.hidden = new lib.MapSchema(); this.list = new lib.ArraySchema(); } }
    field(lib, State, "units", { map: Unit }); field(lib, State, "mirror", { map: Unit });
    field(lib, State, "hidden", { map: Unit }, true); field(lib, State, "list", [Vec2]);
    field(lib, State, "tick", "number");

    const state = new State();
    const encoder = new lib.Encoder(state);
    const clients = [];
    for (let c = 0; c < CLIENTS; c++) {
        const view = new lib.StateView(); view.add(state);
        const decoder = lib.Reflection.decode(lib.Reflection.encode(encoder));
        clients.push({ view, decoder });
    }
    return { Vec2, Unit, state, encoder, clients, pool: [], all: [], n: 0, joined: false, bytes: 0 };
}

// every op draws the same number of randoms on both builds
function step(w, r) {
    const { state, Unit, Vec2 } = w;
    const pick = (arr) => arr.length ? arr[Math.floor(r() * arr.length)] : undefined;
    const attached = (u) => { for (const m of [state.units, state.mirror, state.hidden]) for (const v of m.values()) if (v === u) return true; return false; };
    const ops = 3 + Math.floor(r() * 10);
    for (let o = 0; o < ops; o++) {
        const x = r(), a = r(), b = r(), c = r();
        if (x < 0.12) {
            const u = new Unit(); u.hp = Math.floor(a * 100); u.name = `u${w.n}`; u.pos.x = a; u.pos.y = b; if (!OFF.has('secret')) u.secret = w.n;
            const key = `k${w.n++}`;
            ((c < 0.6 || OFF.has('views')) ? state.units : state.hidden).set(key, u);
            if (c < 0.2 && !OFF.has('share')) state.mirror.set(key, u);
            w.all.push(u);
            if (c >= 0.6 && !OFF.has('views')) for (const cl of w.clients) if (r() < 0.5) cl.view.add(u);
        } else if (x < 0.45) {
            // move a batch: interleaves Unit / Vec2 / Vec2 in the queue
            const n = 1 + Math.floor(a * w.all.length);
            for (let i = 0; i < n && i < w.all.length; i++) {
                const u = w.all[(i + Math.floor(b * w.all.length)) % w.all.length];
                if (c < 0.7) { u.pos.x += 0.5; u.pos.y -= 0.25; }
                if (c > 0.2) { u.vel.x = i + a; u.vel.y = i - a; }
                if (c > 0.5) u.hp = (u.hp + 1) % 100;
                if (c > 0.9 && !OFF.has('secret')) u.secret = i;
            }
        } else if (x < 0.55) {
            for (const m of [state.units, state.mirror, state.hidden]) {
                const k = pick([...m.keys()]);
                if (k !== undefined && r() < 0.5) { const u = m.get(k); m.delete(k); if (!w.pool.includes(u)) w.pool.push(u); }
            }
        } else if (x < 0.68) {
            // re-attach (possibly a detached, client-forgotten instance) and touch it
            const u = pick(w.pool);
            if (u && !OFF.has('reattach')) {
                const key = `r${w.n++}`;
                (a < 0.5 || OFF.has('views') ? state.units : (a < 0.8 && !OFF.has('share')) ? state.mirror : state.hidden).set(key, u);
                if (b < 0.5) { u.pos.x += 1; u.hp = 7; }
                if (c < 0.3) w.pool.splice(w.pool.indexOf(u), 1);
            }
        } else if (x < 0.78) {
            const u = pick(w.all), cl = w.clients[Math.floor(a * w.clients.length)];
            if (u && attached(u) && !OFF.has('views')) { if (b < 0.6) cl.view.add(u); else cl.view.remove(u); }
        } else if (x < 0.86) {
            if (OFF.has('list')) continue;
            if (a < 0.6) { const v = new Vec2(); v.x = a; v.y = b; state.list.push(v); }
            else if (state.list.length) state.list.splice(Math.floor(b * state.list.length), 1);
            for (let i = 0; i < state.list.length; i++) if (((i + o) & 1) === 0) state.list.at(i).x += 1;
        } else if (x < 0.93) {
            const u = pick(w.all);
            if (u && !OFF.has('replace')) { u.pos = new Vec2(); u.pos.x = a; u.pos.y = b; if (c < 0.5) u.vel.x += 1; }
        } else {
            const u = pick(w.all);
            if (u) { u.name = c < 0.5 ? undefined : `n${o}`; u.hp += 1; }
        }
    }
    state.tick++;
}

function tick(w) {
    const { encoder, clients } = w;
    const out = [];
    if (!w.joined) {
        w.joined = true;
        for (const cl of clients) {
            const pair = encodeAllForView(null, encoder, cl.view);
            cl.decoder.decode([pair[0].slice(), pair[1].slice()]);
        }
        encoder.discardChanges();
    } else {
        const it = { offset: 0 };
        encoder.encode(it);
        const shared = it.offset;
        let bytes = 0;
        for (const cl of clients) {
            const pair = encoder.encodeView(cl.view, shared, it);
            bytes += pair[0].byteLength + pair[1].byteLength;
            cl.decoder.decode([pair[0], pair[1]]);
        }
        encoder.discardChanges();
        w.bytes += bytes;
    }
    for (const cl of clients) out.push(JSON.stringify(cl.decoder.state.toJSON()));
    return out;
}

function diffPaths(x, y, path = "", out = []) {
    if (JSON.stringify(x) === JSON.stringify(y)) return out;
    if (x && y && typeof x === "object" && typeof y === "object") for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) diffPaths(x[k], y[k], `${path}.${k}`, out);
    else out.push(`${path}: A=${JSON.stringify(x)} B=${JSON.stringify(y)}`);
    return out;
}

const libA = await import(pathToFileURL(resolve(dirA, "index.mjs")).href);
const libB = await import(pathToFileURL(resolve(dirB, "index.mjs")).href);
const warn = console.warn, err = console.error;
let noise = 0;
console.warn = console.error = () => { noise++; };
let bytesA = 0, bytesB = 0, fails = 0;
for (let seed = 1; seed <= SEEDS; seed++) {
    const wa = world(libA), wb = world(libB);
    const ra = makeRng(seed), rb = makeRng(seed);
    ticks: for (let t = 0; t < TICKS; t++) {
        step(wa, ra); step(wb, rb);
        const a = tick(wa), b = tick(wb);
        for (let c = 0; c < CLIENTS; c++) {
            if (a[c] !== b[c]) {
                fails++;
                if (fails <= 3) err(`MISMATCH seed=${seed} tick=${t} client=${c}: ${diffPaths(JSON.parse(a[c]), JSON.parse(b[c])).slice(0, 6).join(" | ")}`);
                break ticks;
            }
        }
    }
    bytesA += wa.bytes; bytesB += wb.bytes;
}
console.warn = warn; console.error = err;
console.log(`seeds=${SEEDS} ticks=${TICKS} mismatching seeds=${fails} decoder warnings=${noise}  bytes A=${bytesA} B=${bytesB} (${(100 * (bytesB - bytesA) / bytesA).toFixed(1)}%)`);
process.exit(fails ? 1 : 0);
