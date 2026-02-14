import { Class, Property, File, getCommentHeader, getInheritanceTree, Context, Interface } from "../types.js";
import { GenerateOptions } from "../api.js";

export const name = "TypeScript";

const typeMaps: { [key: string]: string } = {
    "string": "string",
    "number": "number",
    "boolean": "boolean",
    "int8": "number",
    "uint8": "number",
    "int16": "number",
    "uint16": "number",
    "int32": "number",
    "uint32": "number",
    "int64": "number",
    "uint64": "number",
    "float32": "number",
    "float64": "number",
}

const COMMON_IMPORTS = `import { Schema, type, ArraySchema, MapSchema, SetSchema, DataChange } from '@colyseus/schema';`;

const distinct = (value: string, index: number, self: string[]) =>
    self.indexOf(value) === index;

/**
 * Generate individual files for each class/interface
 */
export function generate (context: Context, options: GenerateOptions): File[] {
    return [
        ...context.classes.map(structure => ({
            name: structure.name + ".ts",
            content: generateClass(structure, options.namespace, context.classes)
        })),
        ...context.interfaces.map(structure => ({
            name: structure.name + ".ts",
            content: generateInterface(structure, options.namespace, context.classes),
        }))
    ];
}

/**
 * Generate a single bundled file containing all classes and interfaces
 */
export function renderBundle(context: Context, options: GenerateOptions): File {
    const fileName = options.namespace ? `${options.namespace}.ts` : "schema.ts";

    // Collect all class bodies
    const classBodies = context.classes.map(klass => generateClassBody(klass));

    // Collect all interface bodies
    const interfaceBodies = context.interfaces.map(iface => generateInterfaceBody(iface));

    const content = `${getCommentHeader()}

${COMMON_IMPORTS}

${classBodies.join("\n\n")}
${interfaceBodies.length > 0 ? "\n" + interfaceBodies.join("\n\n") : ""}`;

    return { name: fileName, content };
}

/**
 * Generate just the class body (without imports) for bundling
 */
function generateClassBody(klass: Class): string {
    return `export class ${klass.name} extends ${klass.extends} {
${klass.properties.map(prop => `    ${generateProperty(prop)}`).join("\n")}
}`;
}

/**
 * Generate just the interface body (without imports) for bundling
 */
function generateInterfaceBody(iface: Interface): string {
    return `export interface ${iface.name} {
${iface.properties.map(prop => `    ${prop.name}: ${prop.type};`).join("\n")}
}`;
}

/**
 * Generate a complete class file with imports (for individual file mode)
 */
function generateClass(klass: Class, namespace: string, allClasses: Class[]) {
    const allRefs: Property[] = [];
    klass.properties.forEach(property => {
        let type = property.type;

        // keep all refs list
        if ((type === "ref" || type === "array" || type === "map" || type === "set")) {
            allRefs.push(property);
        }
    });

    const localImports = allRefs.
        filter(ref => ref.childType && typeMaps[ref.childType] === undefined).
        map(ref => ref.childType).
        concat(getInheritanceTree(klass, allClasses, false).map(klass => klass.name)).
        filter(distinct).
        map(childType => `import { ${childType} } from './${childType}'`).
        join("\n");

    return `${getCommentHeader()}

${COMMON_IMPORTS}
${localImports}

${generateClassBody(klass)}
`;
}

function generateProperty(prop: Property) {
    let langType: string;
    let initializer = "";
    let typeArgs: string;

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
            typeArgs = `${prop.childType}`;

        } else if(prop.type === "array") {
            langType = (isUpcaseFirst)
                ? `ArraySchema<${prop.childType}>`
                : `ArraySchema<${typeMaps[prop.childType]}>`;
            initializer = `new ${langType}()`;
            typeArgs = (isUpcaseFirst)
                ? `[ ${prop.childType} ]`
                : `[ "${prop.childType}" ]`;

        } else if(prop.type === "map") {
            langType = (isUpcaseFirst)
                ? `MapSchema<${prop.childType}>`
                : `MapSchema<${typeMaps[prop.childType]}>`;
            initializer = `new ${langType}()`;
            typeArgs = (isUpcaseFirst)
                ? `{ map: ${prop.childType} }`
                : `{ map: "${prop.childType}" }`;
        } else if (prop.type === "set") {
            langType = (isUpcaseFirst)
                ? `SetSchema<${prop.childType}>`
                : `SetSchema<${typeMaps[prop.childType]}>`;
            initializer = `new ${langType}()`;
            typeArgs = (isUpcaseFirst)
                ? `{ set: ${prop.childType} }`
                : `{ set: "${prop.childType}" }`;
        }

    } else {
        langType = typeMaps[prop.type];
        typeArgs = `"${prop.type}"`;
    }

    // TS1263: "Declarations with initializers cannot also have definite assignment assertions"
    const definiteAssertion = initializer ? "" : "!";

    return `@type(${typeArgs}) public ${prop.name}${definiteAssertion}: ${langType}${(initializer) ? ` = ${initializer}` : ""};`
}


/**
 * Generate a complete interface file with header (for individual file mode)
 */
function generateInterface(structure: Interface, namespace: string, allClasses: Class[]) {
    return `${getCommentHeader()}

${generateInterfaceBody(structure)}
`;
}
