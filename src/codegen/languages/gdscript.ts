import {
    Class,
    Property,
    File,
    getCommentHeader,
    getInheritanceTree,
    Context,
    Enum,
} from "../types.js";
import { GenerateOptions } from "../api.js";

export const name = "GDScript";

/**
 * Type mappings from schema types to GDScript Colyseus.Schema type constants
 */
const typeMaps: { [key: string]: string } = {
    "string": "Colyseus.Schema.STRING",
    "number": "Colyseus.Schema.NUMBER",
    "boolean": "Colyseus.Schema.BOOLEAN",
    "int8": "Colyseus.Schema.INT8",
    "uint8": "Colyseus.Schema.UINT8",
    "int16": "Colyseus.Schema.INT16",
    "uint16": "Colyseus.Schema.UINT16",
    "int32": "Colyseus.Schema.INT32",
    "uint32": "Colyseus.Schema.UINT32",
    "int64": "Colyseus.Schema.INT64",
    "uint64": "Colyseus.Schema.UINT64",
    "float32": "Colyseus.Schema.FLOAT32",
    "float64": "Colyseus.Schema.FLOAT64",
};

const containerMaps: { [key: string]: string } = {
    "array": "Colyseus.Schema.ARRAY",
    "map": "Colyseus.Schema.MAP",
    "ref": "Colyseus.Schema.REF",
};

const distinct = (value: string, index: number, self: string[]) =>
    self.indexOf(value) === index;

/**
 * GDScript Code Generator
 */

/**
 * Generate individual files for each class
 */
export function generate(context: Context, options: GenerateOptions): File[] {
    // Enrich typeMaps with enums
    context.enums.forEach((structure) => {
        typeMaps[structure.name] = structure.name;
    });

    return [
        ...context.classes.map(klass => ({
            name: `${klass.name}.gd`,
            content: generateClass(klass, options.namespace, context.classes)
        })),
        ...context.enums.filter(structure => structure.name !== 'OPERATION').map((structure) => ({
            name: `${structure.name}.gd`,
            content: generateEnum(structure, options.namespace),
        })),
    ];
}

/**
 * Generate a single bundled file containing all classes and enums
 */
export function renderBundle(context: Context, options: GenerateOptions): File {
    const fileName = options.namespace ? `${options.namespace}.gd` : "schema.gd";

    // Enrich typeMaps with enums
    context.enums.forEach((structure) => {
        typeMaps[structure.name] = structure.name;
    });

    const enumBodies = context.enums
        .filter(structure => structure.name !== 'OPERATION')
        .map(e => generateEnumBody(e));

    const classBodies = context.classes.map(klass => generateClassBody(klass));

    const content = `${getCommentHeader("#")}

${enumBodies.length > 0 ? enumBodies.join("\n\n") + "\n\n" : ""}${classBodies.join("\n\n")}
`;

    return { name: fileName, content };
}

/**
 * Generate just the class body (without preload) for bundling
 */
function generateClassBody(klass: Class): string {
    // Determine parent class
    const parentClass = (klass.extends !== "Schema")
        ? klass.extends
        : "Colyseus.Schema";

    const properties = klass.properties;

    const fieldsContent = properties.length > 0
        ? properties.map(prop => generateFieldDefinition(prop)).join(",\n") + ","
        : "";

    // Generate _to_string() method
    const toStringMethod = generateToStringMethod(klass.name, properties);

    return `class ${klass.name} extends ${parentClass}:
	static func definition():
		return [
${fieldsContent}
		]

${toStringMethod}`;
}

/**
 * Generate _to_string() method for the class
 */
function generateToStringMethod(className: string, properties: Property[]): string {
    const fieldNames = properties.map(prop => prop.name);
    const allFields = ["__ref_id", ...fieldNames];

    const formatParts = allFields.map(name => `${name}: %s`).join(", ");
    const formatString = `${className}(${formatParts})`;

    const selfReferences = allFields.map(name => `self.${name}`).join(", ");

    return `\tfunc _to_string() -> String:
		return "${formatString}" % [${selfReferences}]`;
}

/**
 * Generate a complete class file with preload (for individual file mode)
 */
function generateClass(klass: Class, namespace: string, allClasses: Class[]) {
    const allRefs: Property[] = [];
    klass.properties.forEach(property => {
        let type = property.type;

        // Keep all refs list
        if ((type === "ref" || type === "array" || type === "map")) {
            allRefs.push(property);
        }
    });

    // Get required preloads for referenced types
    const preloads = allRefs
        .filter(ref => ref.childType && typeMaps[ref.childType] === undefined)
        .map(ref => ref.childType)
        .concat(getInheritanceTree(klass, allClasses, false).map(klass => klass.name))
        .filter(distinct)
        .map(childType => `const ${childType} = preload("${childType}.gd")`)
        .join("\n");

    return `${getCommentHeader("#")}

${preloads ? preloads + "\n\n" : ""}${generateClassBody(klass)}
`;
}

/**
 * Generate a field definition for the definition() array
 */
function generateFieldDefinition(prop: Property): string {
    let args: string[];

    if (prop.childType) {
        const isUpcaseFirst = prop.childType.match(/^[A-Z]/);

        // Array or Map container
        const containerType = containerMaps[prop.type];
        const childTypeRef = isUpcaseFirst ? prop.childType : typeMaps[prop.childType] || `"${prop.childType}"`;
        args = [`"${prop.name}"`, containerType, childTypeRef];
    } else {
        // Primitive type
        const typeRef = typeMaps[prop.type] || `"${prop.type}"`;
        args = [`"${prop.name}"`, typeRef];
    }

    return `\t\t\tColyseus.Schema.Field.new(${args.join(", ")})`;
}

/**
 * Generate just the enum body for bundling
 */
function generateEnumBody(_enum: Enum): string {
    const enumValues = _enum.properties.map((prop, index) => {
        let value: any;

        if (prop.type) {
            if (isNaN(Number(prop.type))) {
                value = `"${prop.type}"`;
            } else {
                value = Number(prop.type);
            }
        } else {
            value = index;
        }

        return `\t"${prop.name}": ${value},`;
    }).join("\n");

    return `const ${_enum.name} = {
${enumValues}
}`;
}

/**
 * Generate a complete enum file (for individual file mode)
 */
function generateEnum(_enum: Enum, _namespace: string) {
    return `${getCommentHeader("#")}

${generateEnumBody(_enum)}
`;
}
