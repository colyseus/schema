import {
    Class,
    Property,
    File,
    getCommentHeader,
    Interface,
    Enum,
} from "../types.js";
import { GenerateOptions } from "../api.js";
import { Context } from "../types.js";

export const name = "Unity/C#";

const typeMaps: { [key: string]: string } = {
    "string": "string",
    // JS numbers are float64, and the "number" codec may send them at full width
    "number": "double",
    "boolean": "bool",
    "int8": "sbyte",
    "uint8": "byte",
    "int16": "short",
    "uint16": "ushort",
    "int32": "int",
    "uint32": "uint",
    "int64": "long",
    "uint64": "ulong",
    // float32 only narrows the wire — in memory it's a double, as in JS
    "float32": "double",
    "float64": "double",
}

// SDK types are named through `global::` so that neither the user's namespace
// (`Game.Schema`, `Foo.Colyseus`) nor a generated class can shadow them.
const SDK = "global::Colyseus.Schema";

/**
 * C# reserved keywords — a field with one of these names is emitted
 * `@`-escaped (reflection still reports the bare name the decoder matches on).
 */
const KEYWORDS = new Set([
    "abstract", "as", "base", "bool", "break", "byte", "case", "catch", "char",
    "checked", "class", "const", "continue", "decimal", "default", "delegate",
    "do", "double", "else", "enum", "event", "explicit", "extern", "false",
    "finally", "fixed", "float", "for", "foreach", "goto", "if", "implicit",
    "in", "int", "interface", "internal", "is", "lock", "long", "namespace",
    "new", "null", "object", "operator", "out", "override", "params", "private",
    "protected", "public", "readonly", "ref", "return", "sbyte", "sealed",
    "short", "sizeof", "stackalloc", "static", "string", "struct", "switch",
    "this", "throw", "true", "try", "typeof", "uint", "ulong", "unchecked",
    "unsafe", "ushort", "using", "virtual", "void", "volatile", "while",
]);

const identifier = (name: string) => KEYWORDS.has(name) ? `@${name}` : name;

/**
 * C# Code Generator
 */
const capitalize = (s: string) => {
    if (typeof s !== 'string') return ''
    return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Generate individual files for each class/interface/enum
 */
export function generate(context: Context, options: GenerateOptions): File[] {
    // enrich typeMaps with enums
    context.enums.forEach((structure) => {
        typeMaps[structure.name] = structure.name;
    });
    return [
        ...context.classes.map(structure => ({
            name: `${structure.name}.cs`,
            content: generateClass(structure, options.namespace)
        })),
        ...context.interfaces.map(structure => ({
            name: `${structure.name}.cs`,
            content: generateInterface(structure, options.namespace),
        })),
        ...context.enums.filter(structure => structure.name !== 'OPERATION').map((structure) => ({
            name: `${structure.name}.cs`,
            content: generateEnum(structure, options.namespace),
        })),
    ];
}

/**
 * Generate a single bundled file containing all classes, interfaces, and enums
 */
export function renderBundle(context: Context, options: GenerateOptions): File {
    const fileName = options.namespace ? `${options.namespace}.cs` : "Schema.cs";
    const indent = options.namespace ? "\t" : "";

    // enrich typeMaps with enums
    context.enums.forEach((structure) => {
        typeMaps[structure.name] = structure.name;
    });

    // Collect all bodies
    const classBodies = context.classes.map(klass => generateClassBody(klass, indent));
    const interfaceBodies = context.interfaces.map(iface => generateInterfaceBody(iface, indent));
    const enumBodies = context.enums
        .filter(structure => structure.name !== 'OPERATION')
        .map(e => generateEnumBody(e, indent));

    const allBodies = [...classBodies, ...interfaceBodies, ...enumBodies].join("\n\n");

    const content = `${getCommentHeader()}
${options.namespace ? `\nnamespace ${options.namespace} {\n` : ""}
${allBodies}
${options.namespace ? "}" : ""}`;

    return { name: fileName, content };
}

/**
 * Generate just the class body (without namespace) for bundling
 */
function generateClassBody(klass: Class, indent: string = ""): string {
    const base = (klass.extends === "Schema") ? `${SDK}.Schema` : klass.extends;
    return `${indent}public partial class ${klass.name} : ${base} {
#if UNITY_5_3_OR_NEWER
${indent}\t[global::UnityEngine.Scripting.Preserve]
#endif
${indent}\tpublic ${klass.name}() { }
${klass.properties.map((prop) => "\n" + generateProperty(prop, indent)).join("\n")}
${indent}}`;
}

/**
 * Generate a complete class file with namespace (for individual file mode)
 */
function generateClass(klass: Class, namespace: string) {
    const indent = (namespace) ? "\t" : "";
    return `${getCommentHeader()}
${namespace ? `\nnamespace ${namespace} {` : ""}
${generateClassBody(klass, indent)}
${namespace ? "}" : ""}
`;
}

/**
 * Check if all enum members resolve to non-negative integers,
 * allowing emission as a native C# `enum` (which only supports integral types).
 */
function canUseNativeEnum(_enum: Enum): boolean {
    return _enum.properties.every((prop) => {
        if (!prop.type) return true;
        const n = Number(prop.type);
        return Number.isInteger(n) && n >= 0;
    });
}

/**
 * Generate just the enum body (without imports/namespace) for bundling
 */
function generateEnumBody(_enum: Enum, indent: string = ""): string {
    if (canUseNativeEnum(_enum)) {
        const members = _enum.properties
            .map((prop, i) => {
                const value = prop.type ? Number(prop.type) : i;
                return `${indent}\t${identifier(prop.name)} = ${value},`;
            })
            .join("\n");
        return `${indent}public enum ${_enum.name} : int {
${members}
${indent}}`;
    }

    return `${indent}public struct ${_enum.name} {

${_enum.properties
    .map((prop) => {
        let dataType: string = "int";
        let value: any;

        if(prop.type) {
            if(isNaN(Number(prop.type))) {
                value = `"${prop.type}"`;
                dataType = "string";
            } else {
                value = Number(prop.type);
                dataType = Number.isInteger(value)? 'int': 'float';
            }
        } else {
            value = _enum.properties.indexOf(prop);
        }
        return `${indent}\tpublic const ${dataType} ${identifier(prop.name)} = ${value};`;
    })
        .join("\n")}
${indent}}`;
}

/**
 * Generate a complete enum file with imports/namespace (for individual file mode)
 */
function generateEnum(_enum: Enum, namespace: string) {
    const indent = namespace ? "\t" : "";
    return `${getCommentHeader()}
${namespace ? `\nnamespace ${namespace} {` : ""}
${generateEnumBody(_enum, indent)}
${namespace ? "}" : ""}`
}

function generateProperty(prop: Property, indent: string = "") {
    let typeArgs = `"${prop.type}"`;
    let langType: string;
    let initializer: string;

    if (prop.quantized) {
        const q = prop.quantized;
        typeArgs += `, QuantizeMin = ${q.min}, QuantizeMax = ${q.max}, QuantizeBits = ${q.bits}, QuantizeWrap = ${q.wrap}`;
        langType = "double";
        initializer = defaultLiteral(prop.defaultValue, langType) ?? "default(double)";

    } else if (prop.childType) {
        const isUpcaseFirst = prop.childType.match(/^[A-Z]/);

        langType = getType(prop);
        typeArgs += `, typeof(${langType})`;

        if (!isUpcaseFirst) {
            typeArgs += `, "${prop.childType}"`;
        }

        // collections start empty, as on a JS schema() instance; a child
        // schema stays null until the server sends it
        initializer = (prop.type === "ref") ? "null" : `new ${langType}()`;

    } else {
        langType = getType(prop);
        initializer = defaultLiteral(prop.defaultValue, langType) ?? `default(${langType})`;
    }

    const obsolete = (prop.deprecated)
        ? `\t${indent}[global::System.Obsolete("field '${prop.name}' is deprecated.", true)]\n`
        : "";

    return `${obsolete}\t${indent}[${SDK}.Type(${prop.index}, ${typeArgs})]
\t${indent}public ${langType} ${identifier(prop.name)} = ${initializer};`;
}

const INTEGER_RANGES: { [langType: string]: [number, number] } = {
    "sbyte": [-128, 127],
    "byte": [0, 255],
    "short": [-32768, 32767],
    "ushort": [0, 65535],
    "int": [-2147483648, 2147483647],
    "uint": [0, 4294967295],
    "long": [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    "ulong": [0, Number.MAX_SAFE_INTEGER],
};

// JSON escapes are valid C#, but C# also ends a line at NEL, LS and PS
const CSHARP_LINE_BREAKS = new RegExp(`[${String.fromCharCode(0x85, 0x2028, 0x2029)}]`, "g");

/**
 * A field's statically-known default as a C# literal of `langType`, or
 * undefined when it has none that compiles to the same value.
 */
function defaultLiteral(value: Property["defaultValue"], langType: string): string | undefined {
    if (typeof value === "boolean") {
        return (langType === "bool") ? String(value) : undefined;
    }

    if (typeof value === "string") {
        return (langType === "string")
            ? JSON.stringify(value).replace(CSHARP_LINE_BREAKS, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)
            : undefined;
    }

    if (typeof value !== "number" || !Number.isFinite(value)) {
        return undefined;
    }

    if (langType === "double") {
        return String(value);
    }

    const range = INTEGER_RANGES[langType];
    return (range && Number.isInteger(value) && value >= range[0] && value <= range[1])
        ? String(value)
        : undefined;
}

/**
 * Generate just the interface body (without imports/namespace) for bundling
 */
function generateInterfaceBody(struct: Interface, indent: string = ""): string {
    return `${indent}public class ${struct.name} {
${struct.properties.map(prop => `\t${indent}public ${getType(prop)} ${identifier(prop.name)};`).join("\n")}
${indent}}`;
}

/**
 * Generate a complete interface file with namespace (for individual file mode)
 */
function generateInterface(struct: Interface, namespace: string) {
    const indent = (namespace) ? "\t" : "";
    return `${getCommentHeader()}
${namespace ? `\nnamespace ${namespace} {` : ""}
${generateInterfaceBody(struct, indent)}
${namespace ? "}" : ""}
`;
}

function getChildType(prop: Property) {
    return typeMaps[prop.childType];
}

function getType(prop: Property) {
    if (prop.childType) {
        const isUpcaseFirst = prop.childType.match(/^[A-Z]/);
        let type: string;

        if(prop.type === "ref") {
            type = (isUpcaseFirst)
                ? prop.childType
                : getChildType(prop);
        } else {
            const containerClass = `${SDK}.${capitalize(prop.type)}Schema`;
            type = (isUpcaseFirst)
                ? `${containerClass}<${prop.childType}>`
                : `${containerClass}<${getChildType(prop)}>`;
        }
        return type;

    } else {
        return (prop.type === "array")
            ? `${typeMaps[prop.childType] || prop.childType}[]`
            : typeMaps[prop.type];
    }
}
