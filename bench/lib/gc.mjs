// GC accounting + heap snapshots for benchmark children.
import { PerformanceObserver, constants } from "node:perf_hooks";
import v8 from "node:v8";
import vm from "node:vm";

/** Returns a callable gc() or null. Falls back to the v8-flag trick (works under tsx). */
export function getGcHandle() {
    if (typeof globalThis.gc === "function") return globalThis.gc;
    try {
        v8.setFlagsFromString("--expose-gc");
        const gc = vm.runInNewContext("gc");
        v8.setFlagsFromString("--no-expose-gc");
        return typeof gc === "function" ? gc : null;
    } catch {
        return null;
    }
}

/** Observes "gc" perf entries; snapshot() after a setImmediate so pending entries flush. */
export function createGcTracker() {
    const stats = { count: 0, totalMs: 0, majorMs: 0, minorMs: 0 };
    const observer = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
            stats.count++;
            stats.totalMs += e.duration;
            if (e.detail?.kind === constants.NODE_PERFORMANCE_GC_MAJOR) stats.majorMs += e.duration;
            else stats.minorMs += e.duration;
        }
    });
    observer.observe({ entryTypes: ["gc"], buffered: false });
    return {
        reset() { stats.count = 0; stats.totalMs = 0; stats.majorMs = 0; stats.minorMs = 0; },
        snapshot() {
            return {
                count: stats.count,
                totalMs: +stats.totalMs.toFixed(3),
                majorMs: +stats.majorMs.toFixed(3),
                minorMs: +stats.minorMs.toFixed(3),
            };
        },
        disconnect() { observer.disconnect(); },
    };
}

/** Stabilized heapUsed reading (double gc). */
export function heapUsed(gc) {
    gc(); gc();
    return process.memoryUsage().heapUsed;
}

/**
 * GC perf entries are delivered as macrotasks with latency — setImmediate is
 * NOT enough to flush them, a timer turn is (measured on node 22).
 */
export async function flushGcEntries() {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
}
