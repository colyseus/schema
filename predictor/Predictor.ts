/**
 * Predictor — userland interpolation / extrapolation on top of the public
 * Callbacks API. No library changes: this works against any `Decoder` that
 * has a `StateCallbackStrategy` (via `Callbacks.get(decoder)`).
 *
 * The idea is to prove the shape of the future built-in `@predict` feature
 * without committing to library API or wire-format changes. If users find
 * the ergonomics useful, the same data flow can be lifted into the @type
 * setter/getter machinery.
 *
 * Data flow:
 *
 *   Decoder.decode(bytes)
 *     → setters fire, value lands on instance
 *     → triggerChanges() fires callbacks.listen handlers synchronously
 *     → our handler pushes {time, value} into a 2-sample ring buffer keyed
 *       on (instance, fieldIndex)
 *
 *   user render frame
 *     → predictor.setRenderTime(now)
 *     → predictor.get(instance, field) reads the ring buffer and returns
 *       a computed value based on the field's configured mode
 *
 * The "time" the predictor uses is whatever the caller passes to
 * `samplesReceived(time)` (defaults to `performance.now()`). In production
 * this should be the *server* time for each snapshot — either from the
 * wire (future encoder opt-in) or estimated from user input — so that
 * samples from jittery networks don't drift the interpolant.
 */

import type { Schema } from "../src/Schema";
import { Callbacks, type StateCallbackStrategy } from "../src/decoder/strategy/Callbacks";
import type { Decoder } from "../src/decoder/Decoder";

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

interface Sample {
    t: number;   // time the value arrived
    v: number;
}

interface Slot {
    /** Two most recent samples; `[n-1, n]`. Slot[1] is the newest. */
    samples: [Sample, Sample];
    /** Running `damped` state; only touched in damped mode. */
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

function lerp(a: number, b: number, k: number): number {
    return a + (b - a) * k;
}

function clamp01(k: number): number {
    return k < 0 ? 0 : k > 1 ? 1 : k;
}

export class Predictor<T extends Schema> {
    private callbacks: StateCallbackStrategy<T>;
    /** instance -> field -> slot */
    private slots = new WeakMap<object, Map<string, Slot>>();
    /** Registered detach callbacks per (instance, field) so we can dispose. */
    private detachers = new WeakMap<object, Map<string, () => void>>();

    private renderTime = 0;
    /** Default options for newly-tracked fields. Overridable per-track call. */
    private defaults: Required<PredictOptions>;

    /** How the predictor gets "now" when a sample lands. Override for determinism. */
    public clock: () => number = () => performance.now();

    constructor(decoder: Decoder<T>, defaults: PredictOptions = {}) {
        this.callbacks = Callbacks.get(decoder);
        this.defaults = { ...DEFAULTS, ...defaults };
    }

    /**
     * Start recording samples for `field` on `instance`. Returns a dispose
     * function. Values that land via Decoder callbacks populate the ring
     * buffer; `get(instance, field)` reads the interpolated result.
     */
    track<I extends Schema, K extends keyof I & string>(
        instance: I,
        field: K,
        opts: PredictOptions = {},
    ): () => void {
        const mergedOpts = { ...this.defaults, ...opts };

        const slot: Slot = {
            samples: [
                { t: -Infinity, v: (instance as any)[field] ?? 0 },
                { t: -Infinity, v: (instance as any)[field] ?? 0 },
            ],
            dampedValue: (instance as any)[field] ?? 0,
            lastDampedTime: this.clock(),
            opts: mergedOpts,
        };

        let fieldSlots = this.slots.get(instance);
        if (!fieldSlots) { fieldSlots = new Map(); this.slots.set(instance, fieldSlots); }
        fieldSlots.set(field, slot);

        const detach = this.callbacks.listen(
            instance as any,
            field as any,
            (current: number, _previous: number) => {
                const t = this.clock();
                // shift: samples[0] = previous newest, samples[1] = current
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

    untrack<I extends Schema, K extends keyof I & string>(instance: I, field: K): void {
        this.detachers.get(instance)?.get(field)?.();
        this.detachers.get(instance)?.delete(field);
        this.slots.get(instance)?.delete(field);
    }

    /**
     * Set the current render clock. Call once per frame; all subsequent
     * `get()` reads use this value. Prefer one read per frame over calling
     * `performance.now()` inside every getter.
     */
    setRenderTime(time: number): void { this.renderTime = time; }

    /**
     * Read the interpolated / extrapolated value for `(instance, field)`.
     * If the field was never `track()`-ed, returns the raw current value.
     */
    get<I extends Schema, K extends keyof I & string>(
        instance: I,
        field: K,
    ): number {
        const slot = this.slots.get(instance)?.get(field);
        if (!slot) return (instance as any)[field];

        const now = this.renderTime;
        const [s0, s1] = slot.samples;
        const opts = slot.opts;

        // Damped mode only needs a target, not two samples — advance toward
        // the latest known value regardless of cold-start.
        if (opts.mode === "damped") {
            const dtFrame = now - slot.lastDampedTime;
            slot.lastDampedTime = now;
            if (dtFrame > 0) {
                const k = 1 - Math.exp(-opts.damping * dtFrame / 1000);
                slot.dampedValue = lerp(slot.dampedValue, s1.v, k);
            }
            return slot.dampedValue;
        }

        // lerp / extrapolate need two samples to compute a slope. Before
        // that, return the latest known value (snap on first).
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
