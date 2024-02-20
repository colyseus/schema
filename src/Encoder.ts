import type { Schema } from "./Schema";
import { TypeContext } from "./annotations";
import { $changes, $encoder } from "./changes/consts";

import * as encode from "./encoding/encode";
import { SWITCH_TO_STRUCTURE, TYPE_ID, OPERATION } from './spec';
import { ChangeOperation, ChangeTracker, Root } from "./changes/ChangeTree";
import { encodeKeyValueOperation, encodeSchemaOperation } from "./changes/EncodeOperation";

export class Encoder<T extends Schema = any> {
    context: TypeContext;

    root: T;
    $root: Root;

    constructor(root: T) {
        this.setRoot(root);

        //
        // TODO: cache and restore "Context" based on root schema
        // (to avoid creating a new context for each new room)
        //
        this.context = new TypeContext(root.constructor as typeof Schema);

        // console.log(">>>>>>>>>>>>>>>> Encoder types");
        // this.context.schemas.forEach((id, schema) => {
        //     console.log("type:", id, schema.name, Object.keys(schema[Symbol.metadata]));
        // });
    }

    protected setRoot(root: T) {
        this.$root = new Root();
        this.root = root;
        root[$changes].setRoot(this.$root);
    }

    encode(
        encodeAll = false,
        bytes: number[] = [],
        useFilters: boolean = false,
    ) {
        const rootChangeTree = this.root[$changes];

        // const changeTrees: ChangeTracker[] = Array.from(this.$root['currentQueue']);
        const changeTrees: ChangeTracker[] = this.$root.changes;
        const numChangeTrees = changeTrees.length;
        // let numChangeTrees = 1;

        // console.log("--------------------- ENCODE ----------------");
        // console.log("Encode order:", changeTrees.map((c) => c.ref['constructor'].name));
        for (let i = 0; i < numChangeTrees; i++) {
            const changeTree = changeTrees[i];
            const ref = changeTree.ref;

            const isSchema = ref['constructor'][Symbol.metadata] !== undefined;
            // const metadata = ref['constructor'][Symbol.metadata];

            // const encodeOperation = changeTree['constructor'][$encodeOperation];

            // Generate unique refId for the ChangeTree.
            changeTree.ensureRefId();

            // root `refId` is skipped.
            if (
                changeTree !== rootChangeTree &&
                (changeTree.changed || encodeAll)
            ) {
                encode.uint8(bytes, SWITCH_TO_STRUCTURE);
                encode.number(bytes, changeTree.refId);
            }

            const changes: IterableIterator<ChangeOperation | number> = (encodeAll)
                ? changeTree.allChanges.values()
                : changeTree.changes.values();

            let change: IteratorResult<ChangeOperation | number>;
            while (!(change = changes.next()).done) {
                const operation = (encodeAll)
                    ? OPERATION.ADD
                    : change.value.op;

                const fieldIndex = (encodeAll)
                    ? change.value
                    : change.value.index;

                ref['constructor'][$encoder](this, bytes, changeTree, fieldIndex, operation);
            }

            if (!encodeAll && !useFilters) {
                changeTree.discard();
            }
        }

        return bytes;
    }

    encodeAll (useFilters?: boolean) {
        return this.encode(true, [], useFilters);
    }

    tryEncodeTypeId (bytes: number[], baseType: typeof Schema, targetType: typeof Schema) {
        const baseTypeId = this.context.getTypeId(baseType);
        const targetTypeId = this.context.getTypeId(targetType);

        if (baseTypeId !== targetTypeId) {
            encode.uint8(bytes, TYPE_ID);
            encode.number(bytes, targetTypeId);
        }
    }

}