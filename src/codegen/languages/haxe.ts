import { Class, Property, File, getCommentHeader, Context } from "../types.js";
import { GenerateOptions } from "../api.js";

export const name = "Haxe";

const typeMaps: { [key: string]: string } = {
    "string": "String",
    "number": "Dynamic",
    "boolean": "Bool",
    "int8": "Int",
    "uint8": "UInt",
    "int16": "Int",
    "uint16": "UInt",
    "int32": "Int",
    "uint32": "UInt",
    "int64": "Int",
    "uint64": "UInt",
    "float32": "Float",
    "float64": "Float",
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
import io.colyseus.serializer.schema.types.*;`;

/**
 * Generate individual files for each class
 */
export function generate (context: Context, options: GenerateOptions): File[] {
    return context.classes.map(klass => ({
        name: klass.name + ".hx",
        content: generateClass(klass, options.namespace, context.classes)
    }));
}

/**
 * Generate a single bundled file containing all classes
 */
export function renderBundle(context: Context, options: GenerateOptions): File {
    const fileName = options.namespace ? `${options.namespace}.hx` : "Schema.hx";

    const classBodies = context.classes.map(klass => generateClassBody(klass));

    const content = `${getCommentHeader()}

${options.namespace ? `package ${options.namespace};` : ""}
${COMMON_IMPORTS}

${classBodies.join("\n\n")}
`;

    return { name: fileName, content };
}

function getInheritanceTree(klass: Class, allClasses: Class[], includeSelf: boolean = true) {
    let currentClass = klass;
    let inheritanceTree: Class[] = [];

    if (includeSelf) {
        inheritanceTree.push(currentClass);
    }

    while (currentClass.extends !== "Schema") {
        currentClass = allClasses.find(klass => klass.name == currentClass.extends);
        inheritanceTree.push(currentClass);
    }

    return inheritanceTree;
}

/**
 * Generate just the class body (without package/imports) for bundling
 */
function generateClassBody(klass: Class): string {
    return `class ${klass.name} extends ${klass.extends} {
${klass.properties.map(prop => generateProperty(prop)).join("\n")}
}`;
}

/**
 * Generate a complete class file with package/imports (for individual file mode)
 */
function generateClass(klass: Class, namespace: string, allClasses: Class[]) {
    return `${getCommentHeader()}

${namespace ? `package ${namespace};` : ""}
${COMMON_IMPORTS}

${generateClassBody(klass)}
`;
}

function generateProperty(prop: Property) {
    let langType: string;
    let initializer = "";
    let typeArgs = `"${prop.type}"`;

    if (prop.childType) {
        const isUpcaseFirst = prop.childType.match(/^[A-Z]/);

        if (isUpcaseFirst) {
            typeArgs += `, ${prop.childType}`;

        } else {
            typeArgs += `, "${prop.childType}"`;
        }

        if(prop.type === "ref") {
            langType = `${prop.childType}`;
            initializer = `new ${prop.childType}()`;

        } else if(prop.type === "array") {
            langType = (isUpcaseFirst)
                ? `ArraySchema<${prop.childType}>`
                : `ArraySchema<${typeMaps[prop.childType]}>`;
            initializer = `new ${langType}()`;

        } else if(prop.type === "map") {
            langType = (isUpcaseFirst)
                ? `MapSchema<${prop.childType}>`
                : `MapSchema<${typeMaps[prop.childType]}>`;
            initializer = `new ${langType}()`;
        }

    } else {
        langType = typeMaps[prop.type];
        initializer = typeInitializer[prop.type];
    }

    // TODO: remove initializer. The callbacks at the Haxe decoder side have a
    // "FIXME" comment about this on Decoder.hx

    return `\t@:type(${typeArgs})\n\tpublic var ${prop.name}: ${langType} = ${initializer};\n`
    // return `\t@:type(${typeArgs})\n\tpublic var ${prop.name}: ${langType};\n`
}
