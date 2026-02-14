import { Class, Property, File, getCommentHeader, Context } from "../types.js";
import { GenerateOptions } from "../api.js";

export const name = "Java";

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

const COMMON_IMPORTS = `import io.colyseus.serializer.schema.Schema;
import io.colyseus.serializer.schema.annotations.SchemaClass;
import io.colyseus.serializer.schema.annotations.SchemaField;`;

/**
 * Java Code Generator
 */

/**
 * Generate individual files for each class
 */
export function generate (context: Context, options: GenerateOptions): File[] {
    return context.classes.map(klass => ({
        name: klass.name + ".java",
        content: generateClass(klass, options.namespace)
    }));
}

/**
 * Generate a single bundled file containing all classes
 * Note: Java typically requires one public class per file, so bundled mode
 * generates all classes in a single file with package-private visibility
 */
export function renderBundle(context: Context, options: GenerateOptions): File {
    const fileName = options.namespace ? `Schema.java` : "Schema.java";

    const classBodies = context.classes.map(klass => generateClassBody(klass));

    const content = `${getCommentHeader()}
${options.namespace ? `\npackage ${options.namespace};` : ""}

${COMMON_IMPORTS}

${classBodies.join("\n\n")}
`;

    return { name: fileName, content };
}

/**
 * Generate just the class body (without package/imports) for bundling
 */
function generateClassBody(klass: Class): string {
    return `@SchemaClass
class ${klass.name} extends ${klass.extends} {
${klass.properties.map(prop => generateProperty(prop, "")).join("\n\n")}
}`;
}

/**
 * Generate a complete class file with package/imports (for individual file mode)
 */
function generateClass(klass: Class, namespace: string) {
    const indent = (namespace) ? "\t" : "";
    return `${getCommentHeader()}
${namespace ? `\npackage ${namespace};` : ""}

${COMMON_IMPORTS}

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
