import {
    Class,
    Property,
    File,
    getCommentHeader,
    Interface,
    Enum,
    Context,
} from "../types.js";
import { GenerateOptions } from "../api.js";

export const name = "Dart/Flutter";

/**
 * Dart types for interface (plain message) properties. Schema scalar getters
 * don't use this table: the `colyseus` package reads every numeric field as
 * `double` through `SchemaView`, so all numeric schema types collapse there.
 */
const typeMaps: { [key: string]: string } = {
    "string": "String",
    "number": "double",
    "boolean": "bool",
    "int8": "double",
    "uint8": "double",
    "int16": "double",
    "uint16": "double",
    "int32": "double",
    "uint32": "double",
    "int64": "double",
    "uint64": "double",
    "float32": "double",
    "float64": "double",
}

const enumNames = new Set<string>();

const COMMON_IMPORTS = `import 'package:colyseus/colyseus.dart';`;

// Field names come from the server schema and may not be lowerCamelCase.
const LINT_HEADER = `// ignore_for_file: non_constant_identifier_names, constant_identifier_names`;

const distinct = (value: string, index: number, self: string[]) =>
    self.indexOf(value) === index;

const isSchemaType = (childType: string) =>
    childType !== undefined && /^[A-Z]/.test(childType) && !enumNames.has(childType);

/**
 * Dart Code Generator
 *
 * Emits typed façades over the `colyseus` Flutter package's runtime: one
 * `SchemaRef` subclass per schema, with typed getters over the shared native
 * handle. Collection getters return `MapSchema<T>` / `ArraySchema<T>`, which
 * also carry the field they came from — that is what
 * `callbacks.onAdd(state.players, ...)` registers against.
 */

/**
 * Generate individual files for each class/interface/enum
 */
export function generate(context: Context, options: GenerateOptions): File[] {
    context.enums.forEach((structure) => enumNames.add(structure.name));

    return [
        ...context.classes.map(klass => ({
            name: `${klass.name}.dart`,
            content: generateClass(klass, context.classes)
        })),
        ...context.interfaces.map(structure => ({
            name: `${structure.name}.dart`,
            content: generateInterface(structure),
        })),
        ...context.enums.filter(structure => structure.name !== 'OPERATION').map((structure) => ({
            name: `${structure.name}.dart`,
            content: generateEnum(structure),
        })),
    ];
}

/**
 * Generate a single bundled file containing all classes, interfaces, and enums
 */
export function renderBundle(context: Context, options: GenerateOptions): File {
    const fileName = options.namespace ? `${options.namespace}.dart` : "schema.dart";

    context.enums.forEach((structure) => enumNames.add(structure.name));

    const bodies = [
        ...context.classes.map(klass => generateClassBody(klass, context.classes)),
        ...context.interfaces.map(iface => generateInterfaceBody(iface)),
        ...context.enums
            .filter(structure => structure.name !== 'OPERATION')
            .map(e => generateEnumBody(e)),
    ].join("\n\n");

    const content = `${getCommentHeader()}
${LINT_HEADER}

${COMMON_IMPORTS}

${bodies}
`;

    return { name: fileName, content };
}

/**
 * Generate just the class body (without imports) for bundling
 */
function generateClassBody(klass: Class, allClasses: Class[]): string {
    // `SchemaRef` is a `base` class, so subclasses carry a modifier: `base`
    // when the class is itself extended (extendable from any file), `final`
    // otherwise.
    const isExtended = allClasses.some(other => other.extends === klass.name);
    const modifier = isExtended ? "base" : "final";
    const parent = (klass.extends === "Schema") ? "SchemaRef" : klass.extends;

    const getters = klass.properties
        .map(prop => generateGetter(prop))
        .filter(Boolean)
        .join("\n");

    return `${modifier} class ${klass.name} extends ${parent} {
  ${klass.name}(super.handle);

${getters}
}`;
}

/**
 * Generate a complete class file with imports (for individual file mode)
 */
function generateClass(klass: Class, allClasses: Class[]) {
    const localRefs = klass.properties
        .filter(prop => isSchemaType(prop.childType))
        .map(prop => prop.childType)
        .concat(klass.extends !== "Schema" ? [klass.extends] : [])
        .filter(distinct)
        .filter(ref => ref !== klass.name)
        .map(ref => `import '${ref}.dart';`)
        .join("\n");

    return `${getCommentHeader()}
${LINT_HEADER}

${COMMON_IMPORTS}
${localRefs ? localRefs + "\n" : ""}
${generateClassBody(klass, allClasses)}
`;
}

/**
 * The Dart type a scalar schema field reads as, or undefined when the field
 * can only be read dynamically (enum-typed and unknown types).
 */
function scalarDartType(type: string): string | undefined {
    if (type === "string") { return "String"; }
    if (type === "boolean") { return "bool"; }
    if (typeMaps[type] === "double" || type === "quantized" || type === "number") { return "double"; }
    return undefined;
}

function generateGetter(prop: Property): string {
    const deprecation = (prop.deprecated)
        ? `  @Deprecated("field '${prop.name}' is deprecated.")\n`
        : '';

    let body: string;

    if (prop.childType && isSchemaType(prop.childType)) {
        if (prop.type === "ref") {
            body = `  ${prop.childType}? get ${prop.name} => refOf('${prop.name}', ${prop.childType}.new);`;
        } else if (prop.type === "map") {
            body = `  MapSchema<${prop.childType}> get ${prop.name} => mapOf('${prop.name}', ${prop.childType}.new);`;
        } else {
            body = `  ArraySchema<${prop.childType}> get ${prop.name} => arrayOf('${prop.name}', ${prop.childType}.new);`;
        }
    } else if (prop.childType) {
        const child = typeMaps[prop.childType] ?? "dynamic";
        if (prop.type === "map") {
            body = `  MapSchema<${child}> get ${prop.name} => primitiveMapOf('${prop.name}');`;
        } else if (prop.type === "array") {
            body = `  ArraySchema<${child}> get ${prop.name} => primitiveArrayOf('${prop.name}');`;
        } else {
            // A "ref" with a primitive child has no typed shape to offer.
            body = `  dynamic get ${prop.name} => this['${prop.name}'];`;
        }
    } else {
        const dartType = scalarDartType(prop.type);
        if (dartType === "String") {
            body = `  String get ${prop.name} => view.getString('${prop.name}') ?? '';`;
        } else if (dartType === "bool") {
            body = `  bool get ${prop.name} => view.getBool('${prop.name}');`;
        } else if (dartType === "double") {
            body = `  double get ${prop.name} => view['${prop.name}'];`;
        } else {
            // Enum-typed or unknown: read through the untyped accessor.
            body = `  dynamic get ${prop.name} => this['${prop.name}'];`;
        }
    }

    return deprecation + body;
}

/**
 * Generate just the interface body for bundling
 */
function generateInterfaceBody(struct: Interface): string {
    const fields = struct.properties
        .map(prop => `  ${getInterfaceType(prop)}? ${prop.name};`)
        .join("\n");

    return `class ${struct.name} {
${fields}
}`;
}

/**
 * Generate a complete interface file (for individual file mode)
 */
function generateInterface(struct: Interface) {
    const localRefs = struct.properties
        .filter(prop => isSchemaType(prop.childType ?? (typeMaps[prop.type] ? undefined : prop.type)))
        .map(prop => prop.childType ?? prop.type)
        .filter(distinct)
        .map(ref => `import '${ref}.dart';`)
        .join("\n");

    return `${getCommentHeader()}
${LINT_HEADER}
${localRefs ? "\n" + localRefs + "\n" : ""}
${generateInterfaceBody(struct)}
`;
}

function getInterfaceType(prop: Property): string {
    if (prop.type === "array") {
        return `List<${typeMaps[prop.childType] ?? prop.childType ?? "dynamic"}>`;
    }
    return typeMaps[prop.type] ?? prop.type ?? "dynamic";
}

/**
 * Generate just the enum body for bundling: a namespace of consts, since
 * Colyseus enums may carry string or float values Dart enums can't.
 */
function generateEnumBody(_enum: Enum): string {
    const members = _enum.properties
        .map((prop, i) => {
            let value: string;
            if (prop.type) {
                value = isNaN(Number(prop.type)) ? `"${prop.type}"` : `${Number(prop.type)}`;
            } else {
                value = `${i}`;
            }
            return `  static const ${prop.name} = ${value};`;
        })
        .join("\n");

    return `abstract final class ${_enum.name} {
${members}
}`;
}

/**
 * Generate a complete enum file (for individual file mode)
 */
function generateEnum(_enum: Enum) {
    return `${getCommentHeader()}
${LINT_HEADER}

${generateEnumBody(_enum)}
`;
}
