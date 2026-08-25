import * as assert from "assert";

import { $changes, Encoder, MapSchema, Reflection, Schema, type } from "../src";

describe("Encoder Root", () => {

    class Leaf extends Schema {
        @type("number") value = 0;
    }

    class Branch extends Schema {
        @type({ map: Leaf }) children = new MapSchema<Leaf>();
    }

    class State extends Schema {
        @type({ map: Branch }) actors = new MapSchema<Branch>();
        @type({ map: Branch }) mirror = new MapSchema<Branch>();
        @type({ map: Leaf }) noise = new MapSchema<Leaf>();
    }

    it("repositions a ChangeTree after its parent without scanning the queue", () => {
        const state = new State();
        const encoder = new Encoder(state);
        const decoder = Reflection.decode<State>(Reflection.encode(encoder));

        decoder.decode(encoder.encodeAll());
        encoder.discardChanges();

        // shared branch enqueues first -> its subtree sits at the head
        const shared = new Branch();
        for (let i = 0; i < 4; i++) {
            shared.children.set(`c-${i}`, new Leaf().assign({ value: i }));
        }
        state.actors.set("shared", shared);
        state.mirror.set("shared", shared); // 2nd reference

        // long tail of unrelated dirty trees, same tick
        for (let i = 0; i < 128; i++) {
            state.noise.set(`n-${i}`, new Leaf().assign({ value: i }));
        }

        // sentinel sits far past the scan cap from every node in the subtree
        const sentinel = new Leaf().assign({ value: 99 });
        state.noise.set("sentinel", sentinel);

        const sentinelNode = sentinel[$changes].changesNode!;
        assert.ok(sentinelNode, "sentinel must be queued");

        let sentinelReads = 0;
        let sentinelNext = sentinelNode.next;
        Object.defineProperty(sentinelNode, "next", {
            configurable: true,
            get() { sentinelReads++; return sentinelNext; },
            set(value) { sentinelNext = value; },
        });

        // drops refCount to 1 -> recursivelyMoveNextToParent over the subtree
        state.actors.delete("shared");

        assert.strictEqual(sentinelReads, 0, "queue scan must not walk to the tail");

        decoder.decode(encoder.encode());
        assert.strictEqual(decoder.state.actors.has("shared"), false);
        assert.strictEqual(decoder.state.mirror.get("shared").children.size, 4);
        assert.strictEqual(decoder.state.noise.get("sentinel").value, 99);
    });

    it("keeps parent-before-child ordering after a long-distance move", () => {
        const state = new State();
        const encoder = new Encoder(state);
        const decoder = Reflection.decode<State>(Reflection.encode(encoder));

        decoder.decode(encoder.encodeAll());
        encoder.discardChanges();

        const shared = new Branch();
        for (let i = 0; i < 8; i++) {
            shared.children.set(`c-${i}`, new Leaf().assign({ value: i }));
        }
        state.actors.set("shared", shared);
        for (let i = 0; i < 128; i++) {
            state.noise.set(`n-${i}`, new Leaf().assign({ value: i }));
        }
        state.mirror.set("shared", shared);

        state.actors.delete("shared");

        // must not throw "refId not found" — the moved subtree still decodes
        decoder.decode(encoder.encode());
        assert.strictEqual(decoder.state.mirror.get("shared").children.size, 8);
        for (let i = 0; i < 8; i++) {
            assert.strictEqual(decoder.state.mirror.get("shared").children.get(`c-${i}`).value, i);
        }
    });

    //
    // Instances held by 3+ containers: repositioning a child next to its
    // *primary* parent can jump it ahead of a 2nd/3rd parent whose ADD the
    // decoder must see first ("refId not found"). A capped/heuristic
    // queue scan (MOVE_SCAN_LIMIT) hit exactly this; the O(1) position
    // test + move-to-tail must not. Deterministic PRNG — seeds pinned to
    // ones that desynced under the capped scan.
    //
    it("keeps encode/decode in sync under 3-container instance sharing", () => {
        class FLeaf extends Schema {
            @type("number") value = 0;
            @type("string") label = "";
        }
        class FBranch extends Schema {
            @type({ map: FLeaf }) children = new MapSchema<FLeaf>();
            @type("number") n = 0;
        }
        class FState extends Schema {
            @type({ map: FBranch }) actors = new MapSchema<FBranch>();
            @type({ map: FBranch }) mirror = new MapSchema<FBranch>();
            @type({ map: FBranch }) extra = new MapSchema<FBranch>();
            @type({ map: FLeaf }) noise = new MapSchema<FLeaf>();
            @type("number") tick = 0;
        }

        // mulberry32
        function rng(seed: number) {
            return function () {
                seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
                let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
                t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
                return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
            };
        }

        // Structural invariants the O(1) "is child after parent" test rests
        // on: positions strictly increase along the list, pointers are
        // consistent, and each node is owned by the tree that points at it.
        function assertQueueInvariants(encoder: Encoder, ctx: string) {
            for (const field of ["changesNode", "unreliableChangesNode"] as const) {
                const list = field === "changesNode" ? encoder.root.changes : encoder.root.unreliableChanges;
                let node = list.next;
                let prev: typeof node;
                while (node) {
                    if (prev) {
                        assert.ok(node.position > prev.position, `${ctx}: position not strictly increasing`);
                        assert.strictEqual(node.prev, prev, `${ctx}: broken prev pointer`);
                    } else {
                        assert.strictEqual(node.prev, undefined, `${ctx}: head has a prev`);
                    }
                    assert.strictEqual(node.changeTree[field], node, `${ctx}: node not owned by its tree`);
                    prev = node;
                    node = node.next;
                }
                assert.strictEqual(list.tail, prev, `${ctx}: tail pointer stale`);
            }
        }

        const NOISE = 200;
        for (const seed of [2, 18, 29]) {
            const rand = rng(seed);
            const pick = <T>(arr: T[]): T | undefined => arr.length ? arr[Math.floor(rand() * arr.length)] : undefined;

            const state = new FState();
            const encoder = new Encoder(state);
            const decoder = Reflection.decode<FState>(Reflection.encode(encoder));
            decoder.decode(encoder.encodeAll());
            encoder.discardChanges();

            const branches: FBranch[] = [];
            let counter = 0;

            for (let t = 0; t < 40; t++) {
                state.tick = t;
                const ops = 4 + Math.floor(rand() * 8);
                for (let o = 0; o < ops; o++) {
                    const r = rand();
                    const id = `k-${counter++}`;
                    if (r < 0.16) {
                        const b = new FBranch();
                        b.n = counter;
                        for (let i = 0; i < 1 + Math.floor(rand() * 4); i++) {
                            b.children.set(`c-${i}`, new FLeaf().assign({ value: i, label: `l${i}` }));
                        }
                        state.actors.set(id, b);
                        if (rand() < 0.7) state.mirror.set(id, b);
                        if (rand() < 0.5) state.extra.set(id, b);
                        branches.push(b);
                    } else if (r < 0.30) {
                        // long dirty queue — the move distance the scan cap missed
                        for (let i = 0; i < NOISE + Math.floor(rand() * NOISE * 2); i++) {
                            state.noise.set(`n-${counter}-${i}`, new FLeaf().assign({ value: i }));
                        }
                    } else if (r < 0.46) {
                        const k = pick([...state.actors.keys()]);
                        if (k !== undefined) state.actors.delete(k); // refCount 3->2: triggers the move
                    } else if (r < 0.58) {
                        const k = pick([...state.mirror.keys()]);
                        if (k !== undefined) state.mirror.delete(k);
                    } else if (r < 0.68) {
                        const k = pick([...state.extra.keys()]);
                        if (k !== undefined) state.extra.delete(k);
                    } else if (r < 0.78) {
                        const b = pick(branches);
                        if (b) {
                            b.n = Math.floor(rand() * 1000);
                            const ck = pick([...b.children.keys()]);
                            if (ck !== undefined) b.children.get(ck)!.value = Math.floor(rand() * 1000);
                            if (rand() < 0.3) b.children.set(`c-x-${counter}`, new FLeaf().assign({ value: counter }));
                        }
                    } else if (r < 0.86) {
                        const b = pick(branches);
                        if (b) {
                            state.mirror.set(`re-${counter}`, b);
                            if (rand() < 0.5) state.extra.set(`re-${counter}`, b);
                        }
                    } else if (r < 0.94) {
                        const k = pick([...state.noise.keys()]);
                        if (k !== undefined) state.noise.delete(k);
                    } else {
                        const b = pick(branches);
                        if (b) {
                            for (const k of [...state.actors.keys()]) if (state.actors.get(k) === b) state.actors.delete(k);
                            for (const k of [...state.mirror.keys()]) if (state.mirror.get(k) === b) state.mirror.delete(k);
                            for (const k of [...state.extra.keys()]) if (state.extra.get(k) === b) state.extra.delete(k);
                            branches.splice(branches.indexOf(b), 1);
                        }
                    }
                }

                assertQueueInvariants(encoder, `seed=${seed} tick=${t}`);
                const bytes = encoder.encode();
                encoder.discardChanges();
                decoder.decode(bytes);
                assert.deepStrictEqual(decoder.state.toJSON(), state.toJSON(), `seed=${seed} tick=${t}`);
            }
        }
    });
});
