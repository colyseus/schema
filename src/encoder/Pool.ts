import { Schema } from "../Schema.js";

/**
 * Server-side object pool for Schema instances.
 *
 * Constructing a Schema is comparatively expensive (per-instance ChangeTree +
 * `Object.defineProperty($changes)` + values array, multiplied by the number
 * of instances in the entity tree). For workloads that spawn/despawn entities
 * (ECS, matchmaking bots, projectiles), reusing instances avoids that cost.
 *
 * The pool relies on {@link Schema.reset} to return a detached instance to a
 * pristine, construction-default state — including dropping its `$refId` so a
 * re-add re-acquires a fresh id (making reuse wire-format-identical to `new`).
 *
 * Lifecycle:
 * ```ts
 * const pool = createPool(Entity, { preallocate: 1000 });
 *
 * // spawn
 * const e = pool.acquire();
 * e.x = 10; e.y = 20;            // re-assign fields (pool does NOT reset primitives)
 * state.entities.set(id, e);
 *
 * // despawn — remove from the state tree FIRST, then release
 * state.entities.delete(id);
 * pool.release(e);
 * ```
 *
 * Not supported (throws on release): instances shared across multiple parents,
 * `@stream` collections, and decoder-side (mirror) instances.
 */
export interface PoolOptions {
    /** Construct this many instances up front, so the first spawns reuse rather than allocate. */
    preallocate?: number;
    /**
     * Cap on retained free instances. Releases beyond the cap are dropped (and
     * garbage-collected), keeping a long-running pool bounded. Default: no cap.
     */
    maxSize?: number;
}

/**
 * Object pool for Schema instances. Exported as a **type only** — construct one
 * via {@link createPool}, which is the public entry point. The class is public
 * for typing (`SchemaPool<Entity>` annotations) and `instanceof` checks.
 */
export class SchemaPool<T extends Schema> {
    private readonly _free: T[] = [];
    private readonly _factory: () => T;
    private readonly _maxSize: number;

    constructor(factory: () => T, opts: PoolOptions = {}) {
        this._factory = factory;
        this._maxSize = opts.maxSize ?? Infinity;
        const preallocate = opts.preallocate ?? 0;
        for (let i = 0; i < preallocate; i++) {
            this._free.push(factory());
        }
    }

    /** Pop a pre-reset free instance, or construct a fresh one. */
    acquire(): T {
        return this._free.length > 0 ? this._free.pop()! : this._factory();
    }

    /**
     * Reset `instance` to construction defaults and return it to the pool.
     * PRECONDITION: the instance must already be detached from the state tree
     * (removed from its parent collection/field, so the encoder released it).
     */
    release(instance: T): void {
        Schema.reset(instance);
        if (this._free.length < this._maxSize) {
            this._free.push(instance);
        }
    }

    /** Number of instances currently available for reuse. */
    get size(): number {
        return this._free.length;
    }
}

/** Convenience factory: `createPool(Entity, { preallocate: 64 })`. */
export function createPool<T extends Schema>(
    ctor: new () => T,
    opts: PoolOptions = {},
): SchemaPool<T> {
    return new SchemaPool<T>(() => new ctor(), opts);
}
