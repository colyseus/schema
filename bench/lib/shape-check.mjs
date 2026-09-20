// Hidden-class / elements-kind assertions on live encoder and decoder objects,
// via V8 natives. MUST run with the flag (the file does not parse without it):
//
//   node --allow-natives-syntax bench/lib/shape-check.mjs [buildDir] [--debug-print changeTrees|refCount|hero|tree]
//
// Answers, for a churned room (RPG shape: map deletes + ref replacement) and an
// AOI arena:
//   - did the numeric-keyed refId tables (Root.changeTrees / refCount,
//     ReferenceTracker.refCount / callbacks) fall into dictionary mode?
//   - do encoder-side / decoder-side Schema instances of one class share a map?
//   - do ChangeTrees of Schema / Map / Array refs share a map?
//   - do StateView instances share a map? do tracked and untracked (decoder)
//     instances of the same class share a map?
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const buildDir = resolve(args.find((a) => !a.startsWith("--")) ?? "build");
const debugPrint = args.includes("--debug-print") ? args[args.indexOf("--debug-print") + 1] : null;
const lib = await import(pathToFileURL(resolve(buildDir, "index.mjs")).href);
const rw = await import("./realworld.mjs");

const $changes = Symbol.for("$changes");
const rows = [];
function check(label, fn) {
    let value;
    try { value = fn(); } catch (e) { value = `n/a (${e.message.split("\n")[0]})`; }
    rows.push({ check: label, result: value });
}
function props(label, o) {
    check(`${label}: %HasFastProperties`, () => %HasFastProperties(o));
    check(`${label}: %HasDictionaryElements`, () => %HasDictionaryElements(o));
    check(`${label}: %HasSmiOrObjectElements`, () => %HasSmiOrObjectElements(o));
    check(`${label}: %HasHoleyElements`, () => %HasHoleyElements(o));
}
function same(label, a, b) {
    check(`${label}: %HaveSameMap`, () => %HaveSameMap(a, b));
}

// --- RPG room: encoder + full decoder mirror, 300 churn ticks -----------------
const codec = rw.codecOf(lib);
const rpgShapes = rw.defineRpg(lib);
const rpg = rw.buildRpg(lib, codec, rpgShapes, { heroes: 200, items: 20 });
rpg.encoder.discardChanges();
const client = rw.makeFullClient(lib, codec, rpg.encoder);
const $ = lib.Callbacks.get(client);
$.onAdd("heroes", (hero) => { $.listen(hero, "hp", () => {}); $.onAdd(hero, "inventory", () => {}); });
const ctx = { ...rpg, shapes: rpgShapes };

const encRoot = rpg.encoder.root;
const decRoot = client.root;
props("encoder Root.changeTrees (before churn)", encRoot.changeTrees);
props("encoder Root.refCount (before churn)", encRoot.refCount);
if (decRoot) {
    props("decoder refCount (before churn)", decRoot.refCount);
    props("decoder callbacks (before churn)", decRoot.callbacks);
}
for (let i = 0; i < 300; i++) {
    rw.rpgTick(ctx, i);
    const frame = rpg.encoder.encode().slice();
    rpg.encoder.discardChanges();
    client.decode(frame);
}
props("encoder Root.changeTrees (after 300 churn ticks)", encRoot.changeTrees);
props("encoder Root.refCount (after churn)", encRoot.refCount);
if (decRoot) {
    props("decoder refCount (after churn)", decRoot.refCount);
    props("decoder callbacks (after churn)", decRoot.callbacks);
}

const [h0, h1] = rpg.heroes;
const c0 = client.state.heroes.get(h0.name === "hero-0" ? [...client.state.heroes.keys()][0] : [...client.state.heroes.keys()][0]);
const c1 = client.state.heroes.get([...client.state.heroes.keys()][1]);
props("encoder Hero instance", h0);
props("decoder Hero instance", c0);
same("two encoder Hero instances", h0, h1);
same("two decoder Hero instances", c0, c1);
same("encoder Hero vs decoder Hero (tracked vs untracked)", h0, c0);
same("two encoder Item instances", h0.inventory.get("slot1"), h1.inventory.get("slot2"));
same("two decoder Item instances", c0.inventory.get("slot1"), c1.inventory.get("slot2"));
same("two encoder MapSchema instances", h0.inventory, h1.inventory);
same("two decoder MapSchema instances", c0.inventory, c1.inventory);

const tHero0 = h0[$changes], tHero1 = h1[$changes], tMap = h0.inventory[$changes], tRootMap = rpg.state.heroes[$changes];
props("ChangeTree (Hero)", tHero0);
same("ChangeTree Hero vs Hero", tHero0, tHero1);
same("ChangeTree Hero vs MapSchema", tHero0, tMap);
same("ChangeTree MapSchema vs root MapSchema", tMap, tRootMap);
same("ChangeTree Hero vs State", tHero0, rpg.state[$changes]);

// --- Lobby (ArraySchema tree) ---------------------------------------------------
const lobbyShapes = rw.defineLobby(lib);
const lobby = rw.buildLobby(lib, codec, lobbyShapes, { players: 10, history: 20 });
same("ChangeTree ArraySchema vs Hero", lobby.state.messages[$changes], tHero0);
same("ChangeTree ArraySchema vs MapSchema", lobby.state.messages[$changes], tMap);
props("encoder ArraySchema instance (proxy target)", lobby.state.messages[Symbol.for("$proxyTarget")] ?? lobby.state.messages);

// --- Arena with views ---------------------------------------------------------------
const arenaShapes = rw.defineArena(lib);
const arena = rw.buildArena(lib, codec, arenaShapes, { n: 1000, clients: 20 });
rw.serverTick(codec, arena.encoder, arena.views);
for (let i = 0; i < 100; i++) { rw.moveEntities(arena, 0, 1000); rw.serverTick(codec, arena.encoder, arena.views); }
same("two StateView instances", arena.views[0], arena.views[1]);
props("StateView", arena.views[0]);
same("ChangeTree Entity (filtered) vs Hero (unfiltered)", arena.entities[0][$changes], tHero0);
same("ChangeTree Entity vs Entity", arena.entities[0][$changes], arena.entities[999][$changes]);
props("arena Root.changeTrees (no deletes, 1000 entities)", arena.encoder.root.changeTrees);

// --- report ------------------------------------------------------------------------
const w = Math.max(...rows.map((r) => r.check.length));
console.log(`shape-check against ${buildDir}\n`);
for (const r of rows) console.log(`${r.check.padEnd(w)}  ${r.result}`);

if (debugPrint) {
    const target = { changeTrees: encRoot.changeTrees, refCount: encRoot.refCount, hero: h0, tree: tHero0, decRefCount: decRoot?.refCount }[debugPrint];
    if (target) %DebugPrint(target);
}
