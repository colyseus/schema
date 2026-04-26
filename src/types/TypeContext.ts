import { Metadata } from "../Metadata.js";
import { Schema } from "../Schema.js";
import { $streamFieldIndexes, $viewFieldIndexes } from "./symbols.js";
import { isBitfieldType } from "./custom/BitfieldValue.js";

export class TypeContext {
    types: { [id: number]: typeof Schema; } = {};
    schemas = new Map<typeof Schema, number>();

    hasFilters: boolean = false;
    parentFiltered: {[typeIdAndParentIndex: string]: boolean} = {};
    /**
     * True iff `parentFiltered` has at least one entry. Flipped on by
     * `registerFilteredByParent` and read in `checkInheritedFlags` as a
     * cheap gate to skip the string-keyed `parentFiltered[key]` lookup
     * when no class has registered filter inheritance via ancestry — the
     * common case when @view tags exist only on sibling fields, not
     * along any attachment chain.
     */
    hasParentFilteredEntries: boolean = false;

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

    private discoverTypes(klass: typeof Schema, parentType?: typeof Schema, parentIndex?: number, parentHasViewTag?: boolean) {
        if (parentHasViewTag) {
            this.registerFilteredByParent(klass, parentType, parentIndex);
        }

        // skip if already registered
        if (!this.add(klass)) { return; }

        // add classes inherited from this base class
        TypeContext.inheritedTypes.get(klass)?.forEach((child) => {
            this.discoverTypes(child, parentType, parentIndex, parentHasViewTag);
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
            const fieldHasViewTag = (metadata[index].tag !== undefined);

            if (typeof (fieldType) === "string") {
                continue;
            }

            if (typeof (fieldType) === "function") {
                this.discoverTypes(fieldType as typeof Schema, klass, index, parentHasViewTag || fieldHasViewTag);

            } else {
                // Bitfield: child is a BitfieldLayout, not a Schema. Skip.
                if (isBitfieldType(fieldType)) {
                    continue;
                }

                const type = Object.values(fieldType)[0];

                // skip primitive types
                if (typeof (type) === "string") {
                    continue;
                }

                this.discoverTypes(type as typeof Schema, klass, index, parentHasViewTag || fieldHasViewTag);
            }
        }
    }

    /**
     * Keep track of which classes have filters applied.
     * Format: `${typeid}-${parentTypeid}-${parentIndex}`
     */
    private registerFilteredByParent(schema: typeof Schema, parentType?: typeof Schema, parentIndex?: number) {
        const typeid = this.schemas.get(schema) ?? this.schemas.size;

        let key = `${typeid}`;
        if (parentType) { key += `-${this.schemas.get(parentType)}`; }

        key += `-${parentIndex}`;
        this.parentFiltered[key] = true;
        this.hasParentFilteredEntries = true;
    }

    debug() {
        let parentFiltered = "";

        for (const key in this.parentFiltered) {
            const keys: number[] = key.split("-").map(Number);
            const fieldIndex = keys.pop();

            parentFiltered += `\n\t\t`;
            parentFiltered += `${key}: ${keys.reverse().map((id, i) => {
                const klass = this.types[id];
                const metadata: Metadata = klass[Symbol.metadata];
                let txt = klass.name;
                if (i === 0) { txt += `[${metadata[fieldIndex].name}]`; }
                return `${txt}`;
            }).join(" -> ")}`;
        }

        return `TypeContext ->\n` +
            `\tSchema types: ${this.schemas.size}\n` +
            `\thasFilters: ${this.hasFilters}\n` +
            `\tparentFiltered:${parentFiltered}`;
    }

}
