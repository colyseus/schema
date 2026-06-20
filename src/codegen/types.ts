import * as fs from "fs";
import * as path from "path";

if (typeof(__dirname) === "undefined") {
    global.__dirname = path.dirname(new URL(import.meta.url).pathname);
}

const VERSION = JSON.parse(fs.readFileSync(__dirname + "/../../package.json").toString()).version;
const COMMENT_HEADER = `
THIS FILE HAS BEEN GENERATED AUTOMATICALLY
DO NOT CHANGE IT MANUALLY UNLESS YOU KNOW WHAT YOU'RE DOING

GENERATED USING @colyseus/schema ${VERSION}
`;

export function getCommentHeader(singleLineComment: string = "//") {
    return `${COMMENT_HEADER.split("\n").map(line => `${singleLineComment} ${line}`).join("\n")}`;
}

export class Context {
    classes: Class[] = [];
    interfaces: Interface[] = [];
    enums: Enum[] = [];

    getStructures() {
        // `isSchemaClass` already walks the full ancestor chain, so a class is
        // emitted iff it (or any ancestor) descends from Schema — no need to
        // re-walk parents here.
        return {
            classes: this.classes.filter(klass => this.isSchemaClass(klass)),
            interfaces: this.interfaces,
            enums: this.enums,
        };
    }

    addStructure(structure: IStructure) {
        if (structure.context === this) { return; } // skip if already added.
        structure.context = this;

        if (structure instanceof Class) {
            this.classes.push(structure);
        } else if (structure instanceof Interface) {
            this.interfaces.push(structure);
        } else if (structure instanceof Enum) {
            this.enums.push(structure);
        }
    }

    private isSchemaClass(klass: Class) {
        // True if `klass` or any ancestor extends Schema (directly or via the
        // `schema.Schema` / `Schema.Schema` aliases).
        //
        // TODO: ideally we should check for the actual @colyseus/schema module
        // reference rather than arbitrary strings.
        for (const current of [klass, ...eachAncestor(klass, this.classes)]) {
            const isSchema = (
                current.extends === "Schema" ||
                current.extends === "schema.Schema" ||
                current.extends === "Schema.Schema"
            );
            if (isSchema) {
                // Normalize a `schema.Schema`-style base on the queried class itself.
                if (current === klass) { klass.extends = "Schema"; }
                return true;
            }
        }
        return false;
    }
}

export interface IStructure {
    context: Context;
    name: string;
    properties: Property[];
    addProperty(property: Property): void;
}

export class Interface implements IStructure {
    context: Context;
    name: string;
    properties: Property[] = [];

    addProperty(property: Property): void {
        if (property.type.indexOf("[]") >= 0) {
            // is array!
            property.childType = property.type.match(/([^\[]+)/i)[1];
            property.type = "array";
            this.properties.push(property);

        } else {
            this.properties.push(property);
        }
    }
}

export class Class implements IStructure {
    context: Context;
    name: string;
    properties: Property[] = [];
    extends: string;

    addProperty(property: Property) {
        property.index = this.properties.length;
        this.properties.push(property);
    }

    postProcessing() {
        // Offset each property's `index` by the field count of every ancestor,
        // so indexes stay correct across inheritance.
        for (const parent of eachAncestor(this, this.context.classes)) {
            this.properties.forEach(prop => {
                prop.index += parent.properties.length;
            });
        }
    }
}

export class Enum implements IStructure {
    context: Context;
    name: string;
    properties: Property[] = [];

    addProperty(property: Property) {
        this.properties.push(property);
    }
}

export class Property {
    index: number;
    name: string;
    type: string;
    childType: string;
    deprecated?: boolean;
}

export interface File {
    name: string
    content: string;
}

/**
 * Structured file representation for code generation.
 * Separates imports, local references, and body content to enable
 * clean bundling without string parsing.
 */
export interface GeneratedFile {
    name: string;
    /** External imports (e.g., "@colyseus/schema", "Colyseus.Schema") */
    imports: string[];
    /** References to other generated classes (used for imports in non-bundle mode) */
    localRefs: string[];
    /** The class/interface/enum definition body (without imports or namespace wrapper) */
    body: string;
}

/**
 * Walk `klass`'s `extends` chain, parent-first, yielding each ancestor class
 * (not `klass` itself). The single safe ancestor traversal every inheritance
 * query is built on: it stops at the Schema root, an unresolved base, or a
 * cycle — so a malformed class graph can never spin forever. This is why the
 * `seen` cycle-guard lives here and nowhere else.
 */
function* eachAncestor(klass: Class, allClasses: Class[]): Generator<Class> {
    const seen = new Set<Class>([klass]);
    let current = klass;
    while (current.extends && current.extends !== "Schema") {
        const parent = allClasses.find(c => c.name === current.extends);
        if (!parent || seen.has(parent)) { return; }
        seen.add(parent);
        yield parent;
        current = parent;
    }
}

export function getInheritanceTree(klass: Class, allClasses: Class[], includeSelf: boolean = true) {
    return [
        ...(includeSelf ? [klass] : []),
        ...eachAncestor(klass, allClasses),
    ];
}
