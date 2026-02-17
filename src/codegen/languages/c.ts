import { Class, Property, File, getCommentHeader, getInheritanceTree, Context } from "../types.js";
import { GenerateOptions } from "../api.js";

export const name = "C";

/**
 * Type mappings for C
 */
const typeMaps: { [key: string]: string } = {
    "string": "char*",
    "number": "double",
    "boolean": "bool",
    "int8": "int8_t",
    "uint8": "uint8_t",
    "int16": "int16_t",
    "uint16": "uint16_t",
    "int32": "int32_t",
    "uint32": "uint32_t",
    "int64": "int64_t",
    "uint64": "uint64_t",
    "float32": "float",
    "float64": "double",
};

/**
 * Colyseus field type enum mappings
 */
const fieldTypeMaps: { [key: string]: string } = {
    "string": "COLYSEUS_FIELD_STRING",
    "number": "COLYSEUS_FIELD_NUMBER",
    "boolean": "COLYSEUS_FIELD_BOOLEAN",
    "int8": "COLYSEUS_FIELD_INT8",
    "uint8": "COLYSEUS_FIELD_UINT8",
    "int16": "COLYSEUS_FIELD_INT16",
    "uint16": "COLYSEUS_FIELD_UINT16",
    "int32": "COLYSEUS_FIELD_INT32",
    "uint32": "COLYSEUS_FIELD_UINT32",
    "int64": "COLYSEUS_FIELD_INT64",
    "uint64": "COLYSEUS_FIELD_UINT64",
    "float32": "COLYSEUS_FIELD_FLOAT32",
    "float64": "COLYSEUS_FIELD_FLOAT64",
    "ref": "COLYSEUS_FIELD_REF",
    "array": "COLYSEUS_FIELD_ARRAY",
    "map": "COLYSEUS_FIELD_MAP",
};

const COMMON_INCLUDES = `#include "colyseus/schema/types.h"
#include "colyseus/schema/collections.h"
#include <stdlib.h>
#include <stddef.h>
#include <stdbool.h>`;

/**
 * Native C Code Generator
 */

const toSnakeCase = (s: string) => {
    return s.replace(/([A-Z])/g, (match, p1, offset) =>
        (offset > 0 ? '_' : '') + p1.toLowerCase()
    );
};

const distinct = (value: string, index: number, self: string[]) =>
    self.indexOf(value) === index;

/**
 * Generate individual files for each class
 */
export function generate(context: Context, options: GenerateOptions): File[] {
    return context.classes.map(klass => ({
        name: toSnakeCase(klass.name) + ".h",
        content: generateClass(klass, options.namespace, context.classes)
    }));
}

/**
 * Generate a single bundled header file containing all classes
 */
export function renderBundle(context: Context, options: GenerateOptions): File {
    const fileName = options.namespace ? `${toSnakeCase(options.namespace)}.h` : "schema.h";
    const guardName = `__SCHEMA_CODEGEN_${(options.namespace || "SCHEMA").toUpperCase()}_H__`;

    const classBodies = context.classes.map(klass =>
        generateClassBody(klass, context.classes)
    ).join("\n\n");

    const content = `${getCommentHeader()}
#ifndef ${guardName}
#define ${guardName} 1

${COMMON_INCLUDES}

${classBodies}

#endif
`;

    return { name: fileName, content };
}

/**
 * Generate just the class body (without guards/includes) for bundling
 */
function generateClassBody(klass: Class, allClasses: Class[]): string {
    const snakeName = toSnakeCase(klass.name);
    const typeName = `${snakeName}_t`;
    const allProperties = getAllProperties(klass, allClasses);

    return `${generateTypedef(klass, typeName, allClasses)}

${generateFieldsArray(klass, typeName, snakeName, allProperties)}

${generateCreateFunction(snakeName, typeName)}

${generateDestroyFunction(klass, snakeName, typeName, allProperties)}

${generateVtable(klass, snakeName, typeName, allProperties)}`;
}

/**
 * Generate a complete class file with guards/includes (for individual file mode)
 */
function generateClass(klass: Class, namespace: string, allClasses: Class[]) {
    const snakeName = toSnakeCase(klass.name);
    const typeName = `${snakeName}_t`;
    const guardName = `__SCHEMA_CODEGEN_${klass.name.toUpperCase()}_H__`;

    const allRefs: Property[] = [];

    klass.properties.forEach(property => {
        if (property.type === "ref" || property.type === "array" || property.type === "map") {
            allRefs.push(property);
        }
    });

    // Generate includes for referenced schema types
    const refIncludes = allRefs
        .filter(ref => ref.childType && typeMaps[ref.childType] === undefined)
        .map(ref => ref.childType)
        .concat(getInheritanceTree(klass, allClasses, false).map(k => k.name))
        .filter(distinct)
        .map(childType => `#include "${toSnakeCase(childType)}.h"`)
        .join("\n");

    return `${getCommentHeader()}
#ifndef ${guardName}
#define ${guardName} 1

${COMMON_INCLUDES}
${refIncludes ? `\n${refIncludes}\n` : ""}
${generateClassBody(klass, allClasses)}

#endif
`;
}

function generateTypedef(klass: Class, typeName: string, allClasses: Class[]) {
    const allProperties = getAllProperties(klass, allClasses);

    const fields = allProperties.map(prop => {
        const cType = getCType(prop);
        return `    ${cType} ${prop.name};`;
    }).join("\n");

    return `typedef struct {
    colyseus_schema_t __base;
${fields}
} ${typeName};`;
}

function getCType(prop: Property): string {
    if (prop.type === "ref") {
        return `${toSnakeCase(prop.childType)}_t*`;
    } else if (prop.type === "array") {
        if (typeMaps[prop.childType]) {
            return `colyseus_array_schema_t*`;
        } else {
            return `colyseus_array_schema_t*`;
        }
    } else if (prop.type === "map") {
        if (typeMaps[prop.childType]) {
            return `colyseus_map_schema_t*`;
        } else {
            return `colyseus_map_schema_t*`;
        }
    } else {
        return typeMaps[prop.type] || `${toSnakeCase(prop.type)}_t*`;
    }
}

function getFieldType(prop: Property): string {
    return fieldTypeMaps[prop.type] || "COLYSEUS_FIELD_REF";
}

function getFieldTypeString(prop: Property): string {
    // Always return the type itself (ref, array, map, string, number, etc.)
    return prop.type;
}

function generateFieldsArray(klass: Class, typeName: string, snakeName: string, allProperties: Property[]) {
    if (allProperties.length === 0) {
        return `static const colyseus_field_t ${snakeName}_fields[] = {};`;
    }

    const fields = allProperties.map((prop, i) => {
        const fieldType = getFieldType(prop);
        const typeString = getFieldTypeString(prop);

        let vtableRef = "NULL";

        if (prop.type === "ref" && prop.childType && !typeMaps[prop.childType]) {
            const childSnake = toSnakeCase(prop.childType);
            vtableRef = `&${childSnake}_vtable`;
        } else if ((prop.type === "array" || prop.type === "map") && prop.childType && !typeMaps[prop.childType]) {
            const childSnake = toSnakeCase(prop.childType);
            vtableRef = `&${childSnake}_vtable`;
        }

        return `    {${prop.index}, "${prop.name}", ${fieldType}, "${typeString}", offsetof(${typeName}, ${prop.name}), ${vtableRef}, NULL}`;
    }).join(",\n");

    return `static const colyseus_field_t ${snakeName}_fields[] = {
${fields}
};`;
}

function generateCreateFunction(snakeName: string, typeName: string) {
    return `static ${typeName}* ${snakeName}_create(void) {
    ${typeName}* instance = calloc(1, sizeof(${typeName}));
    return instance;
}`;
}

function generateDestroyFunction(klass: Class, snakeName: string, typeName: string, allProperties: Property[]) {
    const freeStatements: string[] = [];

    allProperties.forEach(prop => {
        if (prop.type === "string") {
            freeStatements.push(`    if (instance->${prop.name}) free(instance->${prop.name});`);
        } else if (prop.type === "ref") {
            if (typeMaps[prop.childType]) {
                freeStatements.push(`    if (instance->${prop.name}) free(instance->${prop.name});`);
            } else {
                const childSnake = toSnakeCase(prop.childType);
                freeStatements.push(`    if (instance->${prop.name}) ${childSnake}_destroy((colyseus_schema_t*)instance->${prop.name});`);
            }
        } else if (prop.type === "array" || prop.type === "map") {
            // arrays and maps are scheduled for destruction at the decoder level
            // freeStatements.push(`    if (instance->${prop.name}) colyseus_${prop.type}_destroy(instance->${prop.name});`);
        }
    });

    const freeCode = freeStatements.length > 0 ? freeStatements.join("\n") + "\n" : "";

    return `static void ${snakeName}_destroy(colyseus_schema_t* schema) {
    ${typeName}* instance = (${typeName}*)schema;
${freeCode}    free(instance);
}`;
}

function generateVtable(klass: Class, snakeName: string, typeName: string, allProperties: Property[]) {
    const fieldCount = allProperties.length;

    return `static const colyseus_schema_vtable_t ${snakeName}_vtable = {
    "${klass.name}",
    sizeof(${typeName}),
    (colyseus_schema_t* (*)(void))${snakeName}_create,
    ${snakeName}_destroy,
    ${snakeName}_fields,
    ${fieldCount}
};`;
}

function getAllProperties(klass: Class, allClasses: Class[]) {
    let properties: Property[] = [];

    getInheritanceTree(klass, allClasses).reverse().forEach((k) => {
        properties = properties.concat(k.properties);
    });

    return properties;
}
