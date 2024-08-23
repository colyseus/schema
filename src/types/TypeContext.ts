import { Metadata } from "../Metadata";
import { Schema } from "../Schema";

export class TypeContext {
    types: { [id: number]: typeof Schema; } = {};
    schemas = new Map<typeof Schema, number>();

    hasFilters: boolean = false;
    parentFiltered: {[typeIdAndParentIndex: string]: boolean} = {};

    /**
     * For inheritance support
     * Keeps track of which classes extends which. (parent -> children)
     */
    static inheritedTypes = new Map<typeof Schema, Set<typeof Schema>>();

    static register(target: typeof Schema) {
        const parent = Object.getPrototypeOf(target);
        if (parent !== Schema) {
            let inherits = TypeContext.inheritedTypes.get(parent);
            if (!inherits) {
                inherits = new Set<typeof Schema>();
                TypeContext.inheritedTypes.set(parent, inherits);
            }
            inherits.add(target);
        }
    }

    constructor(rootClass?: typeof Schema) {
        if (rootClass) {
            this.discoverTypes(rootClass);
        }
    }

    has(schema: typeof Schema) {
        return this.schemas.has(schema);
    }

    get(typeid: number) {
        return this.types[typeid];
    }

    add(schema: typeof Schema, typeid: number = this.schemas.size) {
        // skip if already registered
        if (this.schemas.has(schema)) {
            return false;
        }

        this.types[typeid] = schema;

        //
        // Workaround to allow using an empty Schema (with no `@type()` fields)
        //
        if (schema[Symbol.metadata] === undefined) {
            Metadata.init(schema);
        }

        this.schemas.set(schema, typeid);
        return true;
    }

    getTypeId(klass: typeof Schema) {
        return this.schemas.get(klass);
    }

    private discoverTypes(klass: typeof Schema, parentIndex?: number, parentFieldViewTag?: number) {
        if (!this.add(klass)) {
            return;
        }

        // add classes inherited from this base class
        TypeContext.inheritedTypes.get(klass)?.forEach((child) => {
            this.discoverTypes(child, parentIndex, parentFieldViewTag);
        });

        const metadata: Metadata = (klass[Symbol.metadata] ??= {});

        // if any schema/field has filters, mark "context" as having filters.
        if (metadata[-2]) {
            this.hasFilters = true;
        }

        if (parentFieldViewTag !== undefined) {
            this.parentFiltered[`${this.schemas.get(klass)}-${parentIndex}`] = true;
        }

        for (const fieldIndex in metadata) {
            const index = fieldIndex as any as number;

            const fieldType = metadata[index].type;
            const viewTag = metadata[index].tag;

            if (typeof (fieldType) === "string") {
                continue;
            }

            if (Array.isArray(fieldType)) {
                const type = fieldType[0];

                // skip primitive types
                if (type === "string") {
                    continue;
                }

                this.discoverTypes(type as typeof Schema, index, viewTag);

            } else if (typeof (fieldType) === "function") {
                this.discoverTypes(fieldType as typeof Schema, viewTag);

            } else {
                const type = Object.values(fieldType)[0];

                // skip primitive types
                if (typeof (type) === "string") {
                    continue;
                }

                this.discoverTypes(type as typeof Schema, index, viewTag);
            }
        }
    }
}
