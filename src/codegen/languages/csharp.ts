import { Class, Property, File, getCommentHeader, Interface } from "../types";
import { GenerateOptions } from "../api";
import { Context } from "../types";

const typeMaps = {
    "string": "string",
    "number": "float",
    "boolean": "bool",
    "int8": "int",
    "uint8": "uint",
    "int16": "short",
    "uint16": "ushort",
    "int32": "int",
    "uint32": "uint",
    "int64": "long",
    "uint64": "ulong",
    "float32": "float",
    "float64": "double",
}

/**
 * C# Code Generator
 */
const capitalize = (s) => {
    if (typeof s !== 'string') return ''
    return s.charAt(0).toUpperCase() + s.slice(1);
}

export function generate (context: Context, options: GenerateOptions): File[] {
    return [
        ...context.classes.map(structure => ({
            name: `${structure.name}.cs`,
            content: generateClass(structure, options.namespace)
        })),
        ...context.interfaces.map(structure => ({
            name: `${structure.name}.cs`,
            content: generateInterface(structure, options.namespace)
        }))
    ];
}

function generateClass(klass: Class, namespace: string) {
    const indent = (namespace) ? "\t" : "";
    return `${getCommentHeader()}

using Colyseus.Schema;
${namespace ? `\nnamespace ${namespace} {` : ""}
${indent}public partial class ${klass.name} : ${klass.extends} {
${klass.properties.map(prop => generateProperty(prop, indent)).join("\n\n")}
${indent}}
${namespace ? "}" : ""}
`;
}

function generateProperty(prop: Property, indent: string = "") {
    let typeArgs = `"${prop.type}"`;
    let property = "public";
    let langType: string;
    let initializer = "";

    if (prop.childType) {
        const isUpcaseFirst = prop.childType.match(/^[A-Z]/);

        if(prop.type === "ref") {
            langType = (isUpcaseFirst)
                ? prop.childType
                : typeMaps[prop.childType];

        } else {
            const containerClass = capitalize(prop.type);

            langType = (isUpcaseFirst)
                ? `${containerClass}Schema<${prop.childType}>`
                : `${containerClass}Schema<${typeMaps[prop.childType]}>`;
        }

        typeArgs += `, typeof(${langType})`;

        if (!isUpcaseFirst) {
            typeArgs += `, "${prop.childType}"`;
        }

        initializer = `new ${langType}()`;

    } else {
        langType = typeMaps[prop.type];
        initializer = `default(${langType})`;
    }

    property += ` ${langType} ${prop.name}`;

    let ret = (prop.deprecated) ? `\t\t[System.Obsolete("field '${prop.name}' is deprecated.", true)]\n` : '';

    return ret + `\t${indent}[Type(${prop.index}, ${typeArgs})]
\t${indent}${property} = ${initializer};`;
}

function generateInterface(struct: Interface, namespace: string) {
    const indent = (namespace) ? "\t" : "";
    return `${getCommentHeader()}

using Colyseus.Schema;
${namespace ? `\nnamespace ${namespace} {` : ""}
${indent}public class ${struct.name} {
${struct.properties.map(prop => `\t${indent}public ${typeMaps[prop.type]} ${prop.name};`).join("\n")}
${indent}}
${namespace ? "}" : ""}
`;
}
