import { Schema } from "../Schema";
import { ArraySchema } from "../types/ArraySchema";
import { MapSchema } from "../types/MapSchema";

import { ChangeTree, FieldCache } from "./ChangeTree";

export type Ref = Schema | ArraySchema | MapSchema;

//
// Root holds all schema references by unique id
//
export class Root {
    nextUniqueId: number = 0;
    refs = new Map<number, Ref>();

    changes = new Set<ChangeTree>();
    allChanges = new Set<ChangeTree>();

    // cached indexes for filtering
    caches: {[field: number]: FieldCache} = {};

    dirty(change: ChangeTree) {
        this.changes.add(change);
        this.allChanges.add(change);
    }

    delete (change: ChangeTree) {
        this.changes.delete(change);
        this.allChanges.delete(change);
    }

    cache(field: number, beginIndex: number, endIndex: number) {
        this.caches[field] = { beginIndex, endIndex };
    }
}

export function encode(root: Schema, encodeAll = false, bytes: number[] = [], useFilters: boolean = false) {
    const $root = root['$changes'].root;

    const changeTrees = (encodeAll)
        ? Array.from($root.allChanges)
        : Array.from($root.changes);

    for (let i = 0, l = changeTrees.length; i < l; i++) {
        const change = changeTrees[i];

        // TODO: handle array/map/set
        const ref = change.ref as Schema;

        ref.encode(root, encodeAll, bytes, useFilters);
    }

    return bytes;
}