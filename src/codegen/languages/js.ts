import { Class, Property, File, getCommentHeader, getInheritanceTree, Context } from "../types.js";
import { GenerateOptions } from "../api.js";

export const name = "JavaScript";

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

const COMMON_IMPORTS = `const schema = require("@colyseus/schema");
const Schema = schema.Schema;
const type = schema.type;`;

const distinct = (value: string, index: number, self: string[]) =>
    self.indexOf(value) === index;

/**
 * Generate individual files for each class
 */
export function generate (context: Context, options: GenerateOptions): File[] {
    return context.classes.map(klass => ({
        name: klass.name + ".js",
        content: generateClass(klass, options.namespace, context.classes)
    }));
}

/**
 * Generate a single bundled file containing all classes
 */
export function renderBundle(context: Context, options: GenerateOptions): File {
    const fileName = options.namespace ? `${options.namespace}.js` : "schema.js";

    const classBodies = context.classes.map(klass => generateClassBody(klass));
    const classExports = context.classes.map(klass => `    ${klass.name},`).join("\n");

    const content = `${getCommentHeader()}

${COMMON_IMPORTS}

${classBodies.join("\n\n")}

module.exports = {
${classExports}
};
`;

    return { name: fileName, content };
}

/**
 * Generate just the class body (without imports) for bundling
 */
function generateClassBody(klass: Class): string {
    return `class ${klass.name} extends ${klass.extends} {
    constructor () {
        super();
${klass.properties.
    filter(prop => prop.childType !== undefined).
    map(prop => "        " + generatePropertyInitializer(prop)).join("\n")}
    }
}
${klass.properties.map(prop => generatePropertyDeclaration(klass.name, prop)).join("\n")}`;
}

/**
 * Generate a complete class file with imports (for individual file mode)
 */
function generateClass(klass: Class, namespace: string, allClasses: Class[]) {
    const allRefs: Property[] = [];
    klass.properties.forEach(property => {
        let type = property.type;

        // keep all refs list
        if ((type === "ref" || type === "array" || type === "map")) {
            allRefs.push(property);
        }
    });

    const localImports = allRefs.
        filter(ref => ref.childType && typeMaps[ref.childType] === undefined).
        map(ref => ref.childType).
        concat(getInheritanceTree(klass, allClasses, false).map(klass => klass.name)).
        filter(distinct).
        map(childType => `const ${childType} = require("./${childType}");`).
        join("\n");

    return `${getCommentHeader()}

${COMMON_IMPORTS}
${localImports}

${generateClassBody(klass)}

export default ${klass.name};
`;
}

function generatePropertyDeclaration(className: string, prop: Property) {
    let typeArgs: string;

    if (prop.childType) {
        const isUpcaseFirst = prop.childType.match(/^[A-Z]/);

        if (isUpcaseFirst) {
            typeArgs += `, ${prop.childType}`;

        } else {
            typeArgs += `, "${prop.childType}"`;
        }

        if(prop.type === "ref") {
            typeArgs = `${prop.childType}`;

        } else if(prop.type === "array") {
            typeArgs = (isUpcaseFirst)
                ? `[ ${prop.childType} ]`
                : `[ "${prop.childType}" ]`;

        } else if(prop.type === "map") {
            typeArgs = (isUpcaseFirst)
                ? `{ map: ${prop.childType} }`
                : `{ map: "${prop.childType}" }`;
        }

    } else {
        typeArgs = `"${prop.type}"`;
    }

    return `type(${typeArgs})(${className}.prototype, "${prop.name}");`;
}

function generatePropertyInitializer(prop: Property) {
    let initializer = "";

    if(prop.type === "ref") {
        initializer = `new ${prop.childType}()`;

    } else if(prop.type === "array") {
        initializer = `new schema.ArraySchema()`;

    } else if(prop.type === "map") {
        initializer = `new schema.MapSchema()`;
    }

    return `this.${prop.name} = ${initializer}`;
}
