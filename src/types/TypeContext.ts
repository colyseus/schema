import { Metadata } from "../Metadata.js";
import { Schema } from "../Schema.js";
import { $streamFieldIndexes, $viewFieldIndexes } from "./symbols.js";
import { isQuantizedType } from "./quantize.js";

export class TypeContext {
    types: { [id: number]: typeof Schema; } = {};
    schemas = new Map<typeof Schema, number>();

    hasFilters: boolean = false;

    /**
     * For inheritance support
     * Keeps track of which classes extends which. (parent -> children)
     */
    static inheritedTypes = new Map<typeof Schema, Set<typeof Schema>>();
    static cachedContexts = new Map<typeof Schema, TypeContext>();

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

    static cache (rootClass: typeof Schema) {
        let context = TypeContext.cachedContexts.get(rootClass);
        if (!context) {
            context = new TypeContext(rootClass);
            TypeContext.cachedContexts.set(rootClass, context);
        }
        return context;
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

    add(schema: typeof Schema, typeid = this.schemas.size) {
        // skip if already registered
        if (this.schemas.has(schema)) {
            return false;
        }

        this.types[typeid] = schema;

        //
        // Workaround to allow using an empty Schema (with no `@type()` fields)
        //
        if (schema[Symbol.metadata] === undefined) {
            Metadata.initialize(schema);
        }

        this.schemas.set(schema, typeid);
        return true;
    }

    getTypeId(klass: typeof Schema) {
        return this.schemas.get(klass);
    }

    private discoverTypes(klass: typeof Schema) {
        // skip if already registered
        if (!this.add(klass)) { return; }

        // add classes inherited from this base class
        TypeContext.inheritedTypes.get(klass)?.forEach((child) => {
            this.discoverTypes(child);
        });

        // add parent classes
        let parent: any = klass;
        while (
            (parent = Object.getPrototypeOf(parent)) &&
            parent !== Schema && // stop at root (Schema)
            parent !== Function.prototype // stop at root (non-Schema)
        ) {
            this.discoverTypes(parent);
        }

        const metadata: Metadata = (klass[Symbol.metadata] ??= {} as Metadata);

        // if any schema/field has filters, mark "context" as having filters.
        // Stream fields are always view-scoped — treat like @view tags for
        // filter inheritance.
        if (metadata[$viewFieldIndexes] || metadata[$streamFieldIndexes]) {
            this.hasFilters = true;
        }

        for (const fieldIndex in metadata) {
            const index = fieldIndex as any as number;

            const fieldType = metadata[index].type;

            if (typeof (fieldType) === "string") {
                continue;
            }

            // Quantized fields are scalar — their object `type` only carries the
            // descriptor, there's no child Schema to discover.
            if (isQuantizedType(fieldType)) {
                continue;
            }

            if (typeof (fieldType) === "function") {
                this.discoverTypes(fieldType as typeof Schema);

            } else {
                const type = Object.values(fieldType)[0];

                // skip primitive types
                if (typeof (type) === "string") {
                    continue;
                }

                this.discoverTypes(type as typeof Schema);
            }
        }
    }

    debug() {
        return `TypeContext ->\n` +
            `\tSchema types: ${this.schemas.size}\n` +
            `\thasFilters: ${this.hasFilters}`;
    }

}
