/**
 * Differential harness: the same deterministic mutation script runs against a
 * v5 twin and a v6 twin (own state, own encoder, own clients). After every
 * tick both sides must agree on server JSON, client JSON, encoder/decoder
 * refcounts, decoder `refs` and the multiset of callback events — and emit no
 * warnings.
 */
import * as assert from "assert";
import { Schema, Encoder, Decoder, StateView } from "../../src";
import { Callbacks } from "../../src/decoder/strategy/Callbacks";
import { Encoder6, Decoder6 } from "../../src/v6";
import { $refId, $numFields } from "../../src/types/symbols";
import { assertRefParity, createInstanceFromReflection, getDecoder } from "../Schema";

export type Codec = "v5" | "v6";

/** [kind, ownerRefId, key, value, previous, valueRefId] */
export type LogEntry = [string, number | undefined, string | number | undefined, string, string, number | undefined];

export interface Client<T extends Schema> {
    state: T;
    decoder: Decoder<T> | Decoder6<T>;
    view?: StateView;
    log: LogEntry[];
    totalBytes: number;
}

export interface Side<T extends Schema> {
    codec: Codec;
    state: T;
    encoder: Encoder<T> | Encoder6<T>;
    clients: Client<T>[];
    ctx: Record<string, any>;
}

export interface SideOptions { bufferSize?: number; }

export function makeSides<T extends Schema>(build: () => T, opts: SideOptions = {}): [Side<T>, Side<T>] {
    const size = opts.bufferSize ?? (1 << 20);
    const s5 = build();
    const e5 = new Encoder<T>(s5);
    e5.sharedBuffer = new Uint8Array(size);
    const s6 = build();
    const e6 = new Encoder6<T>(s6);
    e6.sharedBuffer = new Uint8Array(size);
    return [
        { codec: "v5", state: s5, encoder: e5, clients: [], ctx: {} },
        { codec: "v6", state: s6, encoder: e6, clients: [], ctx: {} },
    ];
}

function byteLength(payload: Uint8Array | Uint8Array[]): number {
    return Array.isArray(payload) ? payload.reduce((n, p) => n + p.byteLength, 0) : payload.byteLength;
}

/** Client join: handshake + full sync (+ view region). */
export function join<T extends Schema>(side: Side<T>, viewSetup?: (view: StateView, state: T) => void): Client<T> {
    const state = createInstanceFromReflection(side.state, side.encoder as any);
    const client: Client<T> = { state, decoder: getDecoder(state), view: undefined, log: [], totalBytes: 0 };
    attachLog(client);
    if (viewSetup) {
        client.view = new StateView();
        viewSetup(client.view, side.state);
    }
    const cap = captureConsole();
    try { fullSync(side, client, false); } finally { cap.restore(); }
    assertNoWarnings(cap.lines, /buffer overflow/);
    side.clients.push(client);
    return client;
}

function fullSync<T extends Schema>(side: Side<T>, client: Client<T>, resync: boolean): void {
    const enc: any = side.encoder;
    const it = { offset: 0 };
    const shared: Uint8Array = enc.encodeAll(it);
    let payload: Uint8Array | Uint8Array[] = shared;
    if (client.view) {
        payload = enc.encodeAllView(client.view, it.offset, it);
    }
    client.totalBytes += byteLength(payload);
    const dec: any = client.decoder;
    if (resync) dec.decodeResync(payload); else dec.decode(payload);
}

export interface TickOptions { allowWarnings?: RegExp; skipParity?: boolean; }

/** Mutate both twins, encode shared + per-view, decode ONE session per client, then assert parity. */
export function tick<T extends Schema>(sides: Side<T>[], mutate: (state: T, side: Side<T>) => void, opts: TickOptions = {}): void {
    const cap = captureConsole();
    try {
        for (const side of sides) {
            mutate(side.state, side);
            const enc: any = side.encoder;
            const it = { offset: 0 };
            const shared: Uint8Array = enc.encode(it);
            const sharedOffset = it.offset;
            for (const client of side.clients) {
                const payload: Uint8Array | Uint8Array[] = client.view
                    ? enc.encodeView(client.view, sharedOffset, it)
                    : shared;
                client.totalBytes += byteLength(payload);
                (client.decoder as any).decode(payload);
            }
            enc.discardChanges();
        }
    } finally {
        cap.restore();
    }
    assertNoWarnings(cap.lines, opts.allowWarnings);
    if (!opts.skipParity) assertParity(sides[0], sides[1]);
}

/** Mutate + encode + discard WITHOUT delivering to clients (clients are off the wire). */
export function offline<T extends Schema>(sides: Side<T>[], mutate: (state: T, side: Side<T>) => void): void {
    for (const side of sides) {
        mutate(side.state, side);
        const enc: any = side.encoder;
        const it = { offset: 0 };
        enc.encode(it);
        for (const client of side.clients) {
            if (client.view) enc.encodeView(client.view, it.offset, it);
        }
        enc.discardChanges();
    }
}

/** Late-join reconciliation on every client. */
export function resync<T extends Schema>(sides: Side<T>[], opts: TickOptions = {}): void {
    const cap = captureConsole();
    try {
        for (const side of sides) {
            for (const client of side.clients) fullSync(side, client, true);
            (side.encoder as any).discardChanges();
        }
    } finally {
        cap.restore();
    }
    assertNoWarnings(cap.lines, opts.allowWarnings);
    if (!opts.skipParity) assertParity(sides[0], sides[1]);
}

function assertNoWarnings(lines: string[], allow?: RegExp) {
    const bad = lines.filter((l) => !(allow && allow.test(l)));
    assert.deepStrictEqual(bad, [], "unexpected console output");
}

export function captureConsole() {
    const lines: string[] = [];
    const warn = console.warn, error = console.error;
    console.warn = (...args: any[]) => { lines.push("warn: " + args.map(String).join(" ")); };
    console.error = (...args: any[]) => { lines.push("error: " + args.map(String).join(" ")); };
    return { lines, restore() { console.warn = warn; console.error = error; } };
}

function plainCounts(obj: { [refId: number]: number }) {
    const out: { [refId: string]: number } = {};
    for (const k in obj) out[k] = obj[k];
    return out;
}

export function assertParity<T extends Schema>(a: Side<T>, b: Side<T>): void {
    assert.deepStrictEqual(plainCounts(b.encoder.root.refCount), plainCounts(a.encoder.root.refCount), "twin encoders diverged (refCount)");
    assert.deepStrictEqual(b.state.toJSON(), a.state.toJSON(), "twin states diverged");

    assert.strictEqual(b.clients.length, a.clients.length);
    a.clients.forEach((ca, i) => {
        const cb = b.clients[i];
        const label = `client ${i}`;
        assert.deepStrictEqual(cb.state.toJSON(), ca.state.toJSON(), `${label}: v6 client JSON ≠ v5 client JSON`);
        if (!ca.view && !a.encoder.context.hasFilters) {
            assert.deepStrictEqual(ca.state.toJSON(), a.state.toJSON(), `${label}: v5 client JSON ≠ server`);
            assert.deepStrictEqual(cb.state.toJSON(), b.state.toJSON(), `${label}: v6 client JSON ≠ server`);
            assertRefParity(a.encoder.root, ca.decoder.root, ` (${label} v5)`);
            assertRefParity(b.encoder.root, cb.decoder.root, ` (${label} v6)`);
        }
        assert.deepStrictEqual(plainCounts(cb.decoder.root.refCount), plainCounts(ca.decoder.root.refCount), `${label}: decoder refCount v6 ≠ v5`);
        assert.deepStrictEqual(
            Array.from(cb.decoder.root.refs.keys()).sort((x, y) => x - y),
            Array.from(ca.decoder.root.refs.keys()).sort((x, y) => x - y),
            `${label}: decoder refs v6 ≠ v5`,
        );
        assertLogsEquivalent(ca.log, cb.log, label);
        ca.log.length = 0;
        cb.log.length = 0;
    });
}

function assertLogsEquivalent(a: LogEntry[], b: LogEntry[], label: string) {
    const norm = (log: LogEntry[]) => log.map((e) => JSON.stringify(e)).sort();
    assert.deepStrictEqual(norm(b), norm(a), `${label}: callback events differ`);
    assertSubtreeOrder(a, `${label} v5`);
    assertSubtreeOrder(b, `${label} v6`);
}

/** An onAdd / listen that introduces a Schema value must precede every event on that value's subtree. */
function assertSubtreeOrder(log: LogEntry[], label: string) {
    const introducedAt = new Map<number, number>();
    log.forEach((e, i) => {
        const [kind, owner, , , , valueRefId] = e;
        if ((kind === "onAdd" || kind === "listen") && valueRefId !== undefined && !introducedAt.has(valueRefId)) {
            introducedAt.set(valueRefId, i);
        }
    });
    log.forEach((e, i) => {
        const owner = e[1];
        if (owner === undefined || owner === 0) return;
        const at = introducedAt.get(owner);
        if (at !== undefined) {
            assert.ok(at <= i, `${label}: event on refId ${owner} at #${i} precedes its introduction at #${at}: ${JSON.stringify(e)}`);
        }
    });
}

const bigintReplacer = (_k: string, v: any) => (typeof v === "bigint" ? v.toString() + "n" : v);
const fmt = (v: any) => JSON.stringify(v !== null && typeof v === "object" && typeof v.toJSON === "function" ? v.toJSON() : v, bigintReplacer) ?? "undefined";

/** Register onAdd/onRemove/listen on everything reachable, recursing into added instances. */
export function attachLog<T extends Schema>(client: Client<T>): void {
    const $ = Callbacks.get(client.decoder as any);
    const log = client.log;
    const seen = new WeakSet<object>();

    const attach = (instance: any) => {
        if (!instance || typeof instance !== "object" || seen.has(instance)) return;
        seen.add(instance);
        const metadata = instance.constructor[Symbol.metadata];
        if (!metadata) return;
        const numFields = metadata[$numFields] ?? -1;
        for (let i = 0; i <= numFields; i++) {
            const field = metadata[i];
            if (!field || field.deprecated) continue;
            const t = field.type;
            const name = field.name;
            if (typeof t === "string" || (t && t.quantized !== undefined)) {
                $.listen(instance, name, (value: any, prev: any) => {
                    log.push(["listen", instance[$refId], name, fmt(value), fmt(prev), undefined]);
                });
            } else if (Schema.is(t)) {
                $.listen(instance, name, (value: any, prev: any) => {
                    log.push(["listen", instance[$refId], name, fmt(value), fmt(prev), value?.[$refId]]);
                    attach(value);
                });
            } else {
                $.onAdd(instance, name, (item: any, key: any) => {
                    log.push(["onAdd", instance[$refId], key, fmt(item), "", item?.[$refId]]);
                    attach(item);
                });
                $.onRemove(instance, name, (item: any, key: any) => {
                    log.push(["onRemove", instance[$refId], key, fmt(item), "", item?.[$refId]]);
                });
            }
        }
    };
    attach(client.state);
}

export function report(name: string, sides: Side<any>[]) {
    const totals = sides.map((s) => `${s.codec} ${s.clients.reduce((n, c) => n + c.totalBytes, 0)} B`);
    console.log(`      bytes — ${name}: ${totals.join(" / ")}`);
}
