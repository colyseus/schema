import * as assert from "assert";
import { schema, t, StateView, SchemaType } from "../src";

const Player = schema({ x: t.number(), name: t.string() }, "IAPlayer");
const State = schema({ players: t.map(Player) }, "IAState");

function captureWarn(fn: () => void): string[] {
    const warnings: string[] = [];
    const real = console.warn;
    console.warn = (...a: any[]) => warnings.push(a.map(String).join(" "));
    try { fn(); } finally { console.warn = real; }
    return warnings;
}

describe("StateView: invalid arguments", () => {

    it("add() warns instead of throwing (the guard used to be unreachable)", () => {
        const view = new StateView();
        for (const bad of [undefined, null, {}, [1, 2, 3], "oops", 42]) {
            let threw: any = null;
            const warnings = captureWarn(() => {
                try { view.add(bad as any); } catch (e) { threw = e; }
            });
            assert.strictEqual(threw, null, `add(${String(bad)}) must not throw`);
            assert.strictEqual(warnings.length, 1);
            assert.match(warnings[0], /StateView#add\(\): expected a Schema instance or collection/);
        }
    });

    it("remove() warns instead of throwing", () => {
        const view = new StateView();
        let threw: any = null;
        const warnings = captureWarn(() => {
            try { view.remove(undefined as any); } catch (e) { threw = e; }
        });
        assert.strictEqual(threw, null);
        assert.match(warnings[0], /StateView#remove\(\): expected a Schema instance or collection/);
    });

    it("subscribe() / unsubscribe() warn on a non-Schema argument", () => {
        const view = new StateView();
        assert.match(captureWarn(() => view.subscribe(undefined as any))[0],
            /StateView#subscribe\(\): expected a Schema collection, received undefined/);
        assert.match(captureWarn(() => view.unsubscribe({} as any))[0],
            /StateView#unsubscribe\(\): expected a Schema collection, received Object/);
    });

    it("describes the argument compactly, never dumping a collection", () => {
        const state: SchemaType<typeof State> = new State();
        for (let i = 0; i < 3; i++) {
            state.players.set(`s${i}`, new Player().assign({ x: i, name: `p${i}` }));
        }

        // a populated collection reaches the `priority` guard, not this one,
        // but the same rule applies: one line, no internals.
        const view = new StateView();
        const warnings = captureWarn(() => view.subscribe(state.players as any, (p: any) => p.x));

        assert.strictEqual(warnings.length, 1);
        assert.strictEqual(warnings[0].split("\n").length, 1, "single line");
        for (const internal of ["$items", "journal", "keyByIndex", "$childType", "Symbol("]) {
            assert.ok(!warnings[0].includes(internal), `must not leak ${internal}`);
        }
    });

    it("shapes: primitives, arrays and class instances each read clearly", () => {
        const view = new StateView();
        class Widget {}
        const cases: Array<[any, RegExp]> = [
            [undefined, /received undefined$/],
            [null, /received null$/],
            [42, /received number 42$/],
            [true, /received boolean true$/],
            ["hi", /received "hi"$/],
            [[1, 2], /received Array\(2\)$/],
            [{}, /received Object$/],
            [new Widget(), /received Widget$/],
        ];
        for (const [value, pattern] of cases) {
            const warnings = captureWarn(() => view.add(value as any));
            assert.match(warnings[0], pattern, `for ${String(value)}`);
        }
    });

    it("truncates a long string argument", () => {
        const view = new StateView();
        const warnings = captureWarn(() => view.add("x".repeat(200) as any));
        assert.ok(warnings[0].length < 140, "message stays short");
        assert.match(warnings[0], /…/);
    });
});
