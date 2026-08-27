import {
    Class,
    Property,
    File,
    getCommentHeader,
    Interface,
    Enum,
    Context,
} from "../types.js";
import { GenerateOptions } from "../api.js";

export const name = "Swift";

/**
 * Swift types for interface (plain message) properties. Schema getters do not
 * use this table: the `Colyseus` package reads every numeric field as `Double`
 * through `SchemaView`, so all numeric schema types collapse there.
 */
const typeMaps: { [key: string]: string } = {
    "string": "String",
    "number": "Double",
    "boolean": "Bool",
    "int8": "Int",
    "uint8": "Int",
    "int16": "Int",
    "uint16": "Int",
    "int32": "Int",
    "uint32": "Int",
    "int64": "Int",
    "uint64": "Int",
    "float32": "Double",
    "float64": "Double",
}

const enumNames = new Set<string>();

const COMMON_IMPORTS = `import Colyseus`;

const distinct = (value: string, index: number, self: string[]) =>
    self.indexOf(value) === index;

const isSchemaType = (childType: string) =>
    childType !== undefined && /^[A-Z]/.test(childType) && !enumNames.has(childType);

/**
 * Swift Code Generator
 *
 * Emits typed façades over the `Colyseus` package's runtime: one `SchemaRef`
 * subclass per schema, whose properties read through the shared handle on the
 * instance the core decoded. Nothing is copied and nothing is stored, so a
 * generated class stays correct as patches arrive.
 *
 * Collection properties return `MapSchema<T>` / `ArraySchema<T>`, which carry
 * the field they came from — that is what `callbacks.onAdd(state.players, …)`
 * registers against.
 */

/**
 * Generate individual files for each class/interface/enum
 */
export function generate(context: Context, options: GenerateOptions): File[] {
    context.enums.forEach((structure) => enumNames.add(structure.name));

    return [
        ...context.classes.map(klass => ({
            name: `${klass.name}.swift`,
            content: generateFile(generateClassBody(klass, context.classes, !!options.namespace), options)
        })),
        ...context.interfaces.map(structure => ({
            name: `${structure.name}.swift`,
            content: generateFile(generateInterfaceBody(structure), options),
        })),
        ...context.enums.filter(structure => structure.name !== 'OPERATION').map((structure) => ({
            name: `${structure.name}.swift`,
            content: generateFile(generateEnumBody(structure), options),
        })),
    ];
}

/**
 * Generate a single bundled file containing all classes, interfaces, and enums
 */
export function renderBundle(context: Context, options: GenerateOptions): File {
    const fileName = options.namespace ? `${options.namespace}.swift` : "Schema.swift";

    context.enums.forEach((structure) => enumNames.add(structure.name));

    const bodies = [
        ...context.classes.map(klass => generateClassBody(klass, context.classes, !!options.namespace)),
        ...context.interfaces.map(iface => generateInterfaceBody(iface)),
        ...context.enums
            .filter(structure => structure.name !== 'OPERATION')
            .map(e => generateEnumBody(e)),
    ].join("\n\n");

    return { name: fileName, content: generateFile(bodies, options) };
}

/**
 * Swift has no namespaces, so one stands in as a caseless enum. Declarations
 * go inside it through an extension, which works the same whether they are
 * bundled into one file or split across many.
 */
function generateFile(body: string, options: GenerateOptions): string {
    const header = `${getCommentHeader()}

${COMMON_IMPORTS}
`;

    if (!options.namespace) {
        return `${header}
${body}
`;
    }

    return `${header}
public enum ${options.namespace} {}

extension ${options.namespace} {
${indent(body)}
}
`;
}

function indent(text: string): string {
    return text
        .split("\n")
        .map(line => (line.length > 0 ? `    ${line}` : line))
        .join("\n");
}

function generateClassBody(klass: Class, allClasses: Class[], namespaced: boolean): string {
    // A class nobody extends is final. One that is extended stays open so a
    // consumer in another module can subclass it — except inside a namespace,
    // where `open` conflicts with the extension's own access level and the
    // subclass is generated alongside it anyway.
    const isExtended = allClasses.some(other => other.extends === klass.name);
    const modifier = isExtended ? (namespaced ? "public" : "open") : "public final";
    const parent = (klass.extends === "Schema") ? "SchemaRef" : klass.extends;

    const properties = klass.properties
        .map(prop => generateProperty(prop))
        .filter(Boolean)
        .join("\n");

    // Swift does not carry an `@unchecked Sendable` conformance across module
    // boundaries, so every subclass has to restate it. What it asserts is the
    // SDK's own contract: decoded state is read where it is pumped.
    return `${modifier} class ${klass.name}: ${parent}, @unchecked Sendable {
${properties}
}`;
}

/**
 * The Swift type a scalar schema field reads as, or undefined when the field
 * can only be read dynamically (enum-typed and unknown types).
 */
function scalarSwiftType(type: string): string | undefined {
    if (type === "string") { return "String"; }
    if (type === "boolean") { return "Bool"; }
    if (typeMaps[type] === "Double" || typeMaps[type] === "Int" || type === "quantized" || type === "number") {
        return "Double";
    }
    return undefined;
}

function generateProperty(prop: Property): string {
    const deprecation = (prop.deprecated)
        ? `    @available(*, deprecated, message: "field '${prop.name}' is deprecated.")\n`
        : '';

    const escaped = escapeName(prop.name);
    let body: string;

    if (prop.childType && isSchemaType(prop.childType)) {
        if (prop.type === "ref") {
            body = `    public var ${escaped}: ${prop.childType}? { refOf("${prop.name}") }`;
        } else if (prop.type === "map") {
            body = `    public var ${escaped}: MapSchema<${prop.childType}> { mapOf("${prop.name}") }`;
        } else {
            body = `    public var ${escaped}: ArraySchema<${prop.childType}> { arrayOf("${prop.name}") }`;
        }
    } else if (prop.childType) {
        // A collection of primitives. Everything numeric reads as Double, the
        // same collapse the scalar getters make.
        const child = typeMaps[prop.childType] === "String" ? "String" : "Double";
        if (prop.type === "map") {
            body = `    public var ${escaped}: MapSchema<${child}> { mapOf("${prop.name}") }`;
        } else if (prop.type === "array") {
            body = `    public var ${escaped}: ArraySchema<${child}> { arrayOf("${prop.name}") }`;
        } else {
            // A "ref" with a primitive child has no typed shape to offer.
            body = `    public var ${escaped}: Double { view["${prop.name}"] }`;
        }
    } else {
        const swiftType = scalarSwiftType(prop.type);
        if (swiftType === "String") {
            body = `    public var ${escaped}: String { view.string("${prop.name}") ?? "" }`;
        } else if (swiftType === "Bool") {
            body = `    public var ${escaped}: Bool { view.bool("${prop.name}") }`;
        } else if (swiftType === "Double") {
            body = `    public var ${escaped}: Double { view["${prop.name}"] }`;
        } else {
            // Enum-typed or unknown: read as the number the wire carries.
            body = `    public var ${escaped}: Double { view["${prop.name}"] }`;
        }
    }

    return deprecation + body;
}

/**
 * Message payloads are plain structs rather than façades: they arrive as
 * msgpack, not as decoded schema state.
 */
function generateInterfaceBody(struct: Interface): string {
    const fields = struct.properties
        .map(prop => `    public var ${escapeName(prop.name)}: ${getInterfaceType(prop)}?`)
        .join("\n");

    return `public struct ${struct.name}: Codable {
${fields}

    public init() {}
}`;
}

function getInterfaceType(prop: Property): string {
    if (prop.type === "array") {
        return `[${typeMaps[prop.childType] ?? prop.childType ?? "Double"}]`;
    }
    return typeMaps[prop.type] ?? prop.type ?? "Double";
}

/**
 * A namespace of constants rather than a Swift enum: Colyseus enums may carry
 * string or floating-point values, and a Swift enum's raw type has to be one
 * or the other.
 */
function generateEnumBody(_enum: Enum): string {
    const members = _enum.properties
        .map((prop, i) => {
            let value: string;
            if (prop.type) {
                value = isNaN(Number(prop.type)) ? `"${prop.type}"` : `${Number(prop.type)}`;
            } else {
                value = `${i}`;
            }
            return `    public static let ${escapeName(prop.name)} = ${value}`;
        })
        .join("\n");

    return `public enum ${_enum.name} {
${members}
}`;
}

/** Field names come from the server schema and may collide with a keyword. */
const SWIFT_KEYWORDS = new Set([
    "associatedtype", "class", "deinit", "enum", "extension", "fileprivate", "func", "import",
    "init", "inout", "internal", "let", "open", "operator", "private", "precedencegroup",
    "protocol", "public", "rethrows", "static", "struct", "subscript", "typealias", "var",
    "break", "case", "catch", "continue", "default", "defer", "do", "else", "fallthrough",
    "for", "guard", "if", "in", "repeat", "return", "throw", "switch", "where", "while",
    "Any", "as", "await", "false", "is", "nil", "self", "Self", "super", "throws", "true", "try",
]);

function escapeName(name: string): string {
    return SWIFT_KEYWORDS.has(name) ? `\`${name}\`` : name;
}
