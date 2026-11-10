import * as assert from "assert";
import { execFileSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import * as esbuild from "esbuild";
import { rollup } from "rollup";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import { Encoder, Reflection, schema, t } from "../src";
import { InputDecoder } from "../src/input";

/**
 * Bundles a client app from the built package (`build/`, as installed: through
 * `node_modules`, so each bundler applies the real `exports` and `sideEffects`),
 * minified, then runs it against a server using `src/`. Checks that change
 * tracking is left out and that the tree-shaken client still decodes state
 * and encodes inputs. The client's classes come from its own copy of the
 * library, as in a browser.
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));

const CLIENT_APP = `
export { Decoder, Reflection, Callbacks, schema, t, $changes } from "@colyseus/schema";
export { InputEncoder } from "@colyseus/schema/input";
`;

// Encoder-only internals (as in bench/size.mjs); property names survive minification.
const ENCODER_MARKERS = ["dirtyLow", "unreliableRecorder"];

const BUNDLERS: Record<string, (entry: string, outfile: string) => Promise<void>> = {
    // Vite's production pipeline: rollup tree-shaking, esbuild minification
    async rollup(entry, outfile) {
        const build = await rollup({ input: entry, onwarn: () => {}, plugins: [nodeResolve({ browser: true })] });
        const { output } = await build.generate({ format: "esm" });
        await build.close();
        const { code } = await esbuild.transform(output[0].code, { minify: true, format: "esm", target: "es2022" });
        fs.writeFileSync(outfile, code);
    },
    async esbuild(entry, outfile) {
        await esbuild.build({ entryPoints: [entry], outfile, bundle: true, minify: true, format: "esm", platform: "browser", target: "es2022", logLevel: "silent" });
    },
    async bun(entry, outfile) {
        execFileSync("bun", ["build", entry, "--outfile", outfile, "--minify", "--target", "browser"], { stdio: "pipe" });
    },
};

const hasBun = spawnSync("bun", ["--version"]).status === 0;

function defineTypes(lib: { schema: typeof schema, t: typeof t }) {
    const Item = lib.schema({ x: lib.t.number(), name: lib.t.string(), hist: lib.t.array("number") }, "Item");
    const State = lib.schema({
        item: lib.t.ref(Item),
        items: lib.t.array(Item),
        byId: lib.t.map(Item),
        tags: lib.t.set("string"),
        nums: lib.t.array("number"),
        score: lib.t.number(),
    }, "State");
    const Input = lib.schema({ seq: lib.t.number(), dx: lib.t.number(), fire: lib.t.boolean(), label: lib.t.string() }, "Input");
    return { Item, State, Input };
}

const server = defineTypes({ schema, t });

function random(seed: number) {
    return (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
}

function mutate(state: any, rnd: (n: number) => number) {
    const { Item } = server;
    switch (rnd(9)) {
        case 0: state.items.push(new Item().assign({ x: rnd(100), name: "i" + rnd(9) })); break;
        case 1: if (state.items.length) { state.items.splice(rnd(state.items.length), 1); } break;
        case 2: state.byId.set("k" + rnd(8), new Item().assign({ x: rnd(50) })); break;
        case 3: state.byId.delete("k" + rnd(8)); break;
        case 4: state.tags.add("t" + rnd(6)); break;
        case 5: state.tags.delete("t" + rnd(6)); break;
        case 6: state.nums.push(rnd(1000)); if (state.nums.length > 10) { state.nums.shift(); } break;
        case 7: state.score = rnd(1000); state.item = new Item().assign({ x: rnd(9) }); state.item.hist.push(rnd(5)); break;
        case 8:
            if (rnd(20) === 0) { state.items.clear(); state.byId.clear(); }
            else if (state.items.length) { state.items[rnd(state.items.length)].x = rnd(100); }
            break;
    }
}

function setInput(input: any, rnd: (n: number) => number, seq: number) {
    input.seq = seq;
    if (rnd(2)) { input.dx = rnd(40) / 4 - 5; }
    if (rnd(3) === 0) { input.fire = !input.fire; }
    if (rnd(4) === 0) { input.label = rnd(3) === 0 ? undefined : "l" + rnd(5); }
}

describe("Client bundles (built package, tree-shaken and minified)", function () {
    let dir: string;

    before(() => {
        if (!fs.existsSync(path.join(ROOT, "build/index.mjs"))) {
            throw new Error("build/ is missing: run `npm run build` first");
        }
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "schema-client-bundle-"));
        fs.mkdirSync(path.join(dir, "node_modules/@colyseus"), { recursive: true });
        fs.symlinkSync(ROOT, path.join(dir, "node_modules/@colyseus/schema"), "junction");
        fs.writeFileSync(path.join(dir, "app.mjs"), CLIENT_APP);
    });

    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    for (const [name, bundle] of Object.entries(BUNDLERS)) {
        describe(name, function () {
            this.timeout(60_000);
            let code: string;
            let lib: any;
            let client: ReturnType<typeof defineTypes>;

            before(async function () {
                if (name === "bun" && !hasBun) { this.skip(); }
                const outfile = path.join(dir, `${name}.mjs`);
                await bundle(path.join(dir, "app.mjs"), outfile);
                code = fs.readFileSync(outfile, "utf8");
                lib = await import(pathToFileURL(outfile).href);
                client = defineTypes(lib);
            });

            it("leaves change tracking out", () => {
                assert.deepStrictEqual(ENCODER_MARKERS.filter((m) => code.includes(m)), []);
                assert.strictEqual((new client.State() as any)[lib.$changes].isTracked, false);
            });

            it("decodes server patches (class and Reflection clients, callbacks)", () => {
                const state: any = new server.State();
                const encoder = new Encoder(state);

                const decoded: any = new client.State();
                const decoder = new lib.Decoder(decoded);
                const reflected = lib.Reflection.decode(Reflection.encode(encoder));
                const keys = new Set<string>();
                const callbacks = lib.Callbacks.get(decoder);
                callbacks.onAdd("byId", (_: any, key: string) => keys.add(key));
                callbacks.onRemove("byId", (_: any, key: string) => keys.delete(key));

                const full = encoder.encodeAll();
                decoder.decode(full);
                reflected.decode(full);

                const rnd = random(11);
                for (let tick = 0; tick < 200; tick++) {
                    for (let k = 0; k < 4; k++) { mutate(state, rnd); }
                    const patch = encoder.encode();
                    encoder.discardChanges();
                    decoder.decode(patch);
                    reflected.decode(patch);
                    assert.deepStrictEqual(decoded.toJSON(), state.toJSON(), `class client, tick ${tick}`);
                    assert.deepStrictEqual(reflected.state.toJSON(), state.toJSON(), `Reflection client, tick ${tick}`);
                    assert.deepStrictEqual([...keys].sort(), [...state.byId.keys()].sort(), `onAdd/onRemove, tick ${tick}`);
                }
            });

            it("encodes reliable inputs the server decodes", () => {
                const input: any = new client.Input();
                const encoder = new lib.InputEncoder(input);
                const decoder = new InputDecoder(new server.Input());
                const rnd = random(3);
                for (let seq = 1; seq <= 200; seq++) {
                    setInput(input, rnd, seq);
                    decoder.decode(encoder.encode());
                    assert.deepStrictEqual(decoder.instance.toJSON(), input.toJSON(), `seq ${seq}`);
                }
            });

            it("encodes unreliable inputs that survive dropped packets", () => {
                const historySize = 4;
                const input: any = new client.Input();
                const encoder = new lib.InputEncoder(input, { mode: "unreliable", historySize });
                const decoder = new InputDecoder(new server.Input());
                const rnd = random(5);
                const sent: any[] = [];
                const received: any[] = [];
                let lastSeq = 0, dropped = 0, lost = 0;
                for (let seq = 1; seq <= 200; seq++) {
                    setInput(input, rnd, seq);
                    sent[seq] = input.toJSON();
                    const packet = encoder.encode();
                    if (dropped < historySize - 1 && rnd(3) === 0) { dropped++; lost++; continue; }
                    dropped = 0;
                    decoder.decodeAll(packet, (inst, s) => {
                        if (s > lastSeq) { received[s] = inst.toJSON(); lastSeq = s; }
                    });
                }
                for (let seq = 1; seq <= lastSeq; seq++) {
                    assert.deepStrictEqual(received[seq], sent[seq], `seq ${seq}`);
                }
                assert.ok(lost > 20 && lastSeq >= 190, `lost ${lost}, last seq ${lastSeq}`);
            });
        });
    }
});
