/**
 * Portable Predictor — copy this file into a Colyseus 0.15+ client project
 * to experiment with interpolation / extrapolation / damped smoothing.
 *
 * Depends only on `@colyseus/schema`'s public `Callbacks.get(roomOrDecoder)`
 * API, which accepts any of:
 *   - a `Room` (from colyseus.js)
 *   - a `Decoder<T>`
 *   - `{ serializer: { decoder } }` / `{ state, serializer }` room-shaped objects.
 *
 * Typical usage in a colyseus.js client:
 *
 *     import { Client } from "colyseus.js";
 *     import { Predictor } from "./Predictor";
 *
 *     const room = await client.joinOrCreate("arena");
 *     const predictor = new Predictor(room, { mode: "lerp", delay: 75 });
 *
 *     room.state.players.onAdd((player, sessionId) => {
 *         predictor.track(player, "x");
 *         predictor.track(player, "y");
 *     });
 *
 *     // once per render frame:
 *     function renderLoop(timestamp: number) {
 *         predictor.setRenderTime(timestamp);
 *         room.state.players.forEach((player) => {
 *             const x = predictor.get(player, "x");
 *             const y = predictor.get(player, "y");
 *             drawPlayer(x, y);
 *         });
 *         requestAnimationFrame(renderLoop);
 *     }
 *
 * NOTE: call `predictor.track(instance, field)` AFTER the instance has been
 * delivered by the server (e.g. inside `onAdd`). Tracking an instance that
 * hasn't been decoded yet throws `Can't addCallback (refId is undefined)`.
 */

import { Callbacks } from "@colyseus/schema";

export type PredictMode = "lerp" | "extrapolate" | "damped";

export interface PredictOptions {
    /**
     * `lerp`        — display at `renderTime - delay`, interpolate between
     *                 the two most recent samples. Smooth, lagged.
     * `extrapolate` — linear forecast from the two most recent samples.
     *                 Live, can overshoot.
     * `damped`      — exponential smoothing toward the latest value.
     *                 Never exact, never jittery.
     */
    mode?: PredictMode;
    /** Render-time lag in ms for `lerp` (default 100). Ignored by other modes. */
    delay?: number;
    /** Spring constant for `damped` (default 15 — ~65ms half-life). */
    damping?: number;
    /**
     * Maximum extrapolation overshoot in ms past the latest sample.
     * Beyond this, the last sample is held (clamp). Default 200.
     */
    maxExtrapolate?: number;
}

interface Sample { t: number; v: number; }
interface Slot {
    samples: [Sample, Sample];
    dampedValue: number;
    lastDampedTime: number;
    opts: Required<PredictOptions>;
}

const DEFAULTS: Required<PredictOptions> = {
    mode: "lerp",
    delay: 100,
    damping: 15,
    maxExtrapolate: 200,
};

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const clamp01 = (k: number) => (k < 0 ? 0 : k > 1 ? 1 : k);

// Loose typing: accept anything `Callbacks.get` accepts (Room, Decoder, etc.)
type CallbacksInput = Parameters<typeof Callbacks.get>[0];

export class Predictor {
    private callbacks: ReturnType<typeof Callbacks.get>;
    private slots = new WeakMap<object, Map<string, Slot>>();
    private detachers = new WeakMap<object, Map<string, () => void>>();
    private renderTime = 0;
    private defaults: Required<PredictOptions>;

    /** How the predictor gets "now" when a sample lands. Override for determinism in tests. */
    public clock: () => number = () => performance.now();

    constructor(roomOrDecoder: CallbacksInput, defaults: PredictOptions = {}) {
        this.callbacks = Callbacks.get(roomOrDecoder as any);
        this.defaults = { ...DEFAULTS, ...defaults };
    }

    track(instance: any, field: string, opts: PredictOptions = {}): () => void {
        const mergedOpts = { ...this.defaults, ...opts };

        const slot: Slot = {
            samples: [
                { t: -Infinity, v: instance[field] ?? 0 },
                { t: -Infinity, v: instance[field] ?? 0 },
            ],
            dampedValue: instance[field] ?? 0,
            lastDampedTime: this.clock(),
            opts: mergedOpts,
        };

        let fieldSlots = this.slots.get(instance);
        if (!fieldSlots) { fieldSlots = new Map(); this.slots.set(instance, fieldSlots); }
        fieldSlots.set(field, slot);

        const detach = this.callbacks.listen(
            instance,
            field,
            (current: number, _previous: number) => {
                const t = this.clock();
                slot.samples[0] = slot.samples[1];
                slot.samples[1] = { t, v: current };
            },
            /* immediate */ true,
        );

        let fieldDetachers = this.detachers.get(instance);
        if (!fieldDetachers) { fieldDetachers = new Map(); this.detachers.set(instance, fieldDetachers); }
        fieldDetachers.set(field, detach);

        return () => this.untrack(instance, field);
    }

    untrack(instance: any, field: string): void {
        this.detachers.get(instance)?.get(field)?.();
        this.detachers.get(instance)?.delete(field);
        this.slots.get(instance)?.delete(field);
    }

    setRenderTime(time: number): void { this.renderTime = time; }

    get(instance: any, field: string): number {
        const slot = this.slots.get(instance)?.get(field);
        if (!slot) return instance[field];

        const now = this.renderTime;
        const [s0, s1] = slot.samples;
        const opts = slot.opts;

        if (opts.mode === "damped") {
            const dtFrame = now - slot.lastDampedTime;
            slot.lastDampedTime = now;
            if (dtFrame > 0) {
                const k = 1 - Math.exp(-opts.damping * dtFrame / 1000);
                slot.dampedValue = lerp(slot.dampedValue, s1.v, k);
            }
            return slot.dampedValue;
        }

        if (!isFinite(s0.t)) return s1.v;

        if (opts.mode === "lerp") {
            const target = now - opts.delay;
            const dt = s1.t - s0.t;
            if (dt <= 0) return s1.v;
            return lerp(s0.v, s1.v, clamp01((target - s0.t) / dt));
        }

        // extrapolate
        const dt = s1.t - s0.t;
        if (dt <= 0) return s1.v;
        const ahead = now - s1.t;
        const clampedAhead = ahead > opts.maxExtrapolate ? opts.maxExtrapolate : ahead;
        return s1.v + (s1.v - s0.v) * (clampedAhead / dt);
    }
}
