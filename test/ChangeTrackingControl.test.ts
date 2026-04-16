import * as assert from "assert";
import { Schema, type, MapSchema, ArraySchema } from "../src";
import "./Schema"; // installs Schema.prototype.encode / decode / encodeAll helpers

describe("Change tracking control API", () => {
    class Player extends Schema {
        @type("string") name: string;
        @type("uint16") hp: number;
        @type("uint8") level: number;
    }

    class State extends Schema {
        @type(Player) player = new Player();
        @type({ map: Player }) players = new MapSchema<Player>();
        @type([Player]) roster = new ArraySchema<Player>();
    }

    describe("Schema: pauseTracking / resumeTracking", () => {
        it("pauseTracking prevents mutations from appearing in the patch", () => {
            const state = new State();
            const decoder = new State();

            state.player.name = "alice";
            decoder.decode(state.encode());
            assert.strictEqual(decoder.player.name, "alice");

            // Pause, mutate, resume. The mutations should NOT be encoded.
            state.player.pauseTracking();
            state.player.name = "bob";
            state.player.hp = 999;
            state.player.resumeTracking();

            const bytes = state.encode();
            decoder.decode(bytes);
            // Decoder still sees "alice", not "bob" — the paused mutation wasn't sent.
            assert.strictEqual(decoder.player.name, "alice");

            // Resuming: subsequent mutations are tracked again.
            state.player.name = "charlie";
            decoder.decode(state.encode());
            assert.strictEqual(decoder.player.name, "charlie");
        });

        it("isTrackingPaused reflects current state", () => {
            const p = new Player();
            assert.strictEqual(p.isTrackingPaused, false);
            p.pauseTracking();
            assert.strictEqual(p.isTrackingPaused, true);
            p.resumeTracking();
            assert.strictEqual(p.isTrackingPaused, false);
        });

        it("pause/resume across multiple encode cycles", () => {
            const state = new State();
            const decoder = new State();

            state.player.name = "first";
            decoder.decode(state.encode());
            assert.strictEqual(decoder.player.name, "first");

            // Cycle: mutate while paused — encode emits nothing for this field.
            state.player.pauseTracking();
            state.player.name = "hidden";
            state.player.resumeTracking();
            decoder.decode(state.encode());
            assert.strictEqual(decoder.player.name, "first"); // still first

            // Normal mutation — emits as expected.
            state.player.name = "second";
            decoder.decode(state.encode());
            assert.strictEqual(decoder.player.name, "second");
        });
    });

    describe("untracked(fn)", () => {
        it("runs fn with tracking paused, resumes after, no side effects on decoder", () => {
            const state = new State();
            const decoder = new State();

            state.player.name = "baseline";
            decoder.decode(state.encode());

            state.player.untracked(() => {
                state.player.name = "invisible";
                state.player.hp = 42;
            });

            assert.strictEqual(state.player.isTrackingPaused, false); // resumed

            decoder.decode(state.encode());
            // Decoder shouldn't have seen the invisible values.
            assert.strictEqual(decoder.player.name, "baseline");
        });

        it("nested untracked() calls preserve outer paused state", () => {
            const state = new State();
            state.player.name = "outer-before";

            state.player.untracked(() => {
                assert.strictEqual(state.player.isTrackingPaused, true);

                state.player.untracked(() => {
                    assert.strictEqual(state.player.isTrackingPaused, true);
                    state.player.name = "deep";
                });

                // Inner untracked shouldn't have "resumed" (we were already paused).
                assert.strictEqual(state.player.isTrackingPaused, true);
            });

            // Outer untracked resumed normally.
            assert.strictEqual(state.player.isTrackingPaused, false);
        });

        it("untracked() returns the fn's return value", () => {
            const p = new Player();
            const result = p.untracked(() => {
                p.hp = 100;
                return "done";
            });
            assert.strictEqual(result, "done");
        });

        it("untracked() resumes even if fn throws", () => {
            const p = new Player();
            p.pauseTracking();
            try {
                p.untracked(() => { throw new Error("boom"); });
            } catch { /* expected */ }
            // We were already paused before — untracked should restore that state.
            assert.strictEqual(p.isTrackingPaused, true);
        });
    });

    describe("collections", () => {
        it("pause on MapSchema prevents entries from being tracked", () => {
            const state = new State();
            const decoder = new State();

            // Seed initial state so players ref exists on decoder.
            state.players.set("warmup", new Player().assign({ name: "w" }));
            decoder.decode(state.encode());

            state.players.pauseTracking();
            state.players.set("a", new Player().assign({ name: "a" }));
            state.players.set("b", new Player().assign({ name: "b" }));
            state.players.resumeTracking();

            decoder.decode(state.encode());

            // Decoder only has the warmup entry.
            assert.strictEqual(decoder.players.size, 1);
            // Server-side state still has all entries.
            assert.strictEqual(state.players.size, 3);
        });

        it("untracked on ArraySchema", () => {
            const state = new State();
            const decoder = new State();

            state.roster.push(new Player().assign({ name: "seed" }));
            decoder.decode(state.encode());

            state.roster.untracked(() => {
                state.roster.push(new Player().assign({ name: "p1" }));
                state.roster.push(new Player().assign({ name: "p2" }));
            });

            decoder.decode(state.encode());
            assert.strictEqual(decoder.roster.length, 1);
            assert.strictEqual(state.roster.length, 3);
        });
    });

    describe("bulk loading pattern (real use case)", () => {
        it("load many fields without emitting changes", () => {
            const state = new State();
            const decoder = new State();

            // Seed an initial state so decoder.player exists.
            state.player.name = "seed";
            decoder.decode(state.encode());
            assert.strictEqual(decoder.player.name, "seed");

            // Simulate loading state from disk without emitting a patch.
            state.player.untracked(() => {
                state.player.name = "from-disk";
                state.player.hp = 75;
                state.player.level = 10;
            });

            // Next encode emits nothing meaningful for the player — its
            // change tree wasn't updated.
            const bytes = state.encode();
            decoder.decode(bytes);

            // Decoder didn't receive the bulk load.
            assert.strictEqual(decoder.player.name, "seed");

            // State is locally correct on the server.
            assert.strictEqual(state.player.name, "from-disk");
            assert.strictEqual(state.player.hp, 75);
            assert.strictEqual(state.player.level, 10);
        });
    });
});
