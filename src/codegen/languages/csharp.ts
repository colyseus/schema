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
    "number": "float",
    "boolean": "bool",
    "int8": "sbyte",
    "uint8": "byte",
    "int16": "short",
    "uint16": "ushort",
    "int32": "int",
    "uint32": "uint",
    "int64": "long",
    "uint64": "ulong",
    "float32": "float",
    "float64": "double",
}

const COMMON_IMPORTS = `using Colyseus.Schema;
#if UNITY_5_3_OR_NEWER
using UnityEngine.Scripting;
#endif`;

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

${COMMON_IMPORTS}
${options.namespace ? `\nnamespace ${options.namespace} {\n` : ""}
${allBodies}
${options.namespace ? "}" : ""}`;

    return { name: fileName, content };
}

/**
 * Generate just the class body (without imports/namespace) for bundling
 */
function generateClassBody(klass: Class, indent: string = ""): string {
    return `${indent}public partial class ${klass.name} : ${klass.extends} {
#if UNITY_5_3_OR_NEWER
[Preserve]
#endif
public ${klass.name}() { }
${klass.properties.map((prop) => generateProperty(prop, indent)).join("\n\n")}
${indent}}`;
}

/**
 * Generate a complete class file with imports/namespace (for individual file mode)
 */
function generateClass(klass: Class, namespace: string) {
    const indent = (namespace) ? "\t" : "";
    return `${getCommentHeader()}

${COMMON_IMPORTS}
${namespace ? `\nnamespace ${namespace} {` : ""}
${generateClassBody(klass, indent)}
${namespace ? "}" : ""}
`;
}

/**
 * Generate just the enum body (without imports/namespace) for bundling
 */
function generateEnumBody(_enum: Enum, indent: string = ""): string {
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
        return `${indent}\tpublic const ${dataType} ${prop.name} = ${value};`;
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
    let property = "public";
    let langType: string;
    let initializer = "";

    if (prop.childType) {
        const isUpcaseFirst = prop.childType.match(/^[A-Z]/);

        langType = getType(prop);
        typeArgs += `, typeof(${langType})`;

        if (!isUpcaseFirst) {
            typeArgs += `, "${prop.childType}"`;
        }

        initializer = `null`;

    } else {
        langType = getType(prop);
        initializer = `default(${langType})`;
    }

    property += ` ${langType} ${prop.name}`;

    let ret = (prop.deprecated) ? `\t\t[System.Obsolete("field '${prop.name}' is deprecated.", true)]\n` : '';

    return ret + `\t${indent}[Type(${prop.index}, ${typeArgs})]
\t${indent}${property} = ${initializer};`;
}

/**
 * Generate just the interface body (without imports/namespace) for bundling
 */
function generateInterfaceBody(struct: Interface, indent: string = ""): string {
    return `${indent}public class ${struct.name} {
${struct.properties.map(prop => `\t${indent}public ${getType(prop)} ${prop.name};`).join("\n")}
${indent}}`;
}

/**
 * Generate a complete interface file with imports/namespace (for individual file mode)
 */
function generateInterface(struct: Interface, namespace: string) {
    const indent = (namespace) ? "\t" : "";
    return `${getCommentHeader()}

using Colyseus.Schema;
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
            const containerClass = capitalize(prop.type);
            type = (isUpcaseFirst)
                ? `${containerClass}Schema<${prop.childType}>`
                : `${containerClass}Schema<${getChildType(prop)}>`;
        }
        return type;

    } else {
        return (prop.type === "array")
            ? `${typeMaps[prop.childType] || prop.childType}[]`
            : typeMaps[prop.type];
    }
}
