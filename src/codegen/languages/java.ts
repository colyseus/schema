import { Class, Property, File, getCommentHeader, Context } from "../types";
import { GenerateOptions } from "../api";

const typeMaps: { [key: string]: string } = {
    "string": "String",
    "number": "float",
    "boolean": "boolean",
    "int8": "byte",
    "uint8": "short",
    "int16": "short",
    "uint16": "int",
    "int32": "int",
    "uint32": "long",
    "int64": "long",
    "uint64": "long",
    "float32": "float",
    "float64": "double",
}

const typeInitializer: { [key: string]: string } = {
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

export function generate (context: Context, options: GenerateOptions): File[] {
    return context.classes.map(klass => ({
        name: klass.name + ".java",
        content: generateClass(klass, options.namespace)
    }));
}

function generateClass(klass: Class, namespace: string) {
    const indent = (namespace) ? "\t" : "";
    return `${getCommentHeader()}
${namespace ? `\npackage ${namespace};` : ""}

import io.colyseus.serializer.schema.Schema;
import io.colyseus.serializer.schema.annotations.SchemaClass;
import io.colyseus.serializer.schema.annotations.SchemaField;

@SchemaClass
${indent}public class ${klass.name} extends ${klass.extends} {
${klass.properties.map(prop => generateProperty(prop, indent)).join("\n\n")}
${indent}}
${namespace ? "}" : ""}
`;
}

function generateProperty(prop: Property, indent: string = "") {
    let typeArgs = `${prop.index}/${prop.type}`;
    let property = "public";
    let langType: string;
    let ctorArgs: string = "";
    let initializer = "";

    if (prop.childType) {
        const isUpcaseFirst = prop.childType.match(/^[A-Z]/);

        if (prop.type !== "ref" && isUpcaseFirst) {
            ctorArgs = `${prop.childType}.class`;
        }

        if(prop.type === "ref") {
            langType = (isUpcaseFirst)
                ? prop.childType
                : typeMaps[prop.childType];

            initializer = `new ${langType}${(prop.type !== "ref" && isUpcaseFirst) ? "<>" : ""}(${ctorArgs})`;

        } else if(prop.type === "array") {
            langType = (isUpcaseFirst)
                ? `ArraySchema<${prop.childType}>`
                : `ArraySchema`;

            initializer = `new ArraySchema${(isUpcaseFirst) ? "<>" : ""}(${ctorArgs})`;

        } else if(prop.type === "map") {
            langType = (isUpcaseFirst)
                ? `MapSchema<${prop.childType}>`
                : `MapSchema`;

            initializer = `new MapSchema${(isUpcaseFirst) ? "<>" : ""}(${ctorArgs})`;
        }

        if (prop.type !== "ref") {
            typeArgs += (isUpcaseFirst)
                ? `/ref`
                : `/${prop.childType}`;
        }

    } else {
        langType = typeMaps[prop.type];
        initializer = typeInitializer[prop.type];
    }

    property += ` ${langType} ${prop.name}`;

    return `\t@SchemaField("${typeArgs}")\t${indent}
\t${indent}${property} = ${initializer};`
}
