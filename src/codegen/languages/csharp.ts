import { Class, Property, File, getCommentHeader } from "./types";

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

const typeInitializer = {
    "string": '""',
    "number": "0",
    "boolean": "false",
    "int8": "0",
    "uint8": "0",
    "int16": "0",
    "uint16": "0",
    "int32": "0",
    "uint32": "0",
    "int64": "0",
    "uint64": "0",
    "float32": "0",
    "float64": "0",
}

/**
 * C# Code Generator
 */

export function generate (classes: Class[], args: any): File[] {
    return classes.map(klass => ({
        name: klass.name + ".cs",
        content: generateClass(klass, args.namespace)
    }));
}

function generateClass(klass: Class, namespace: string) {
    const indent = (namespace) ? "\t" : "";
    return `${getCommentHeader()}

using Colyseus.Schema;
${namespace ? `\nnamespace ${namespace} {` : ""}
${indent}public class ${klass.name} : ${klass.extends} {
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

        } else if(prop.type === "array") {
            langType = (isUpcaseFirst)
                ? `ArraySchema<${prop.childType}>`
                : `ArraySchema<${typeMaps[prop.childType]}>`;

        } else if(prop.type === "map") {
            langType = (isUpcaseFirst)
                ? `MapSchema<${prop.childType}>`
                : `MapSchema<${typeMaps[prop.childType]}>`;
        }

        if (isUpcaseFirst) {
            typeArgs += `, typeof(${langType})`;

        } else {
            typeArgs += `, "${prop.childType}"`;
        }

        initializer = `new ${langType}()`;

    } else {
        langType = typeMaps[prop.type];
        initializer = typeInitializer[prop.type];
    }

    property += ` ${langType} ${prop.name}`;

    return `\t${indent}[Type(${prop.index}, ${typeArgs})]
\t${indent}${property} = ${initializer};`
}
