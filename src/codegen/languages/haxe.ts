import { Class, Property, File, getCommentHeader, Context } from "../types.js";
import { GenerateOptions } from "../api.js";

export const name = "Haxe";

/**
 * Field types follow what the Haxe SDK's decoder hands back: `number` arrives
 * as an Int or a Float, so it is a `Float`; integers up to 32 bits are `Int`
 * (signed arithmetic, like the number the server holds — a `uint32` above
 * 2^31 reads negative); 64-bit integers decode as `haxe.Int64`.
 */
const typeMaps: { [key: string]: string } = {
    "string": "String",
    "number": "Float",
    "boolean": "Bool",
    "int8": "Int",
    "uint8": "Int",
    "int16": "Int",
    "uint16": "Int",
    "int32": "Int",
    "uint32": "Int",
    "int64": "haxe.Int64",
    "uint64": "haxe.Int64",
    "float32": "Float",
    "float64": "Float",
}

/** The value a field without a `.default()` starts at. */
const zeroOf = (langType: string) => (langType === "String") ? '""' : (langType === "Bool") ? "false" : "0";

/**
 * Haxe reserved words. A field named after one is emitted with a trailing
 * underscore — the SDK matches fields by index on the wire, never by name.
 */
const KEYWORDS = new Set([
    "abstract", "break", "case", "cast", "catch", "class", "continue", "default",
    "do", "dynamic", "else", "enum", "extends", "extern", "false", "final", "for",
    "function", "if", "implements", "import", "in", "inline", "interface", "macro",
    "new", "null", "operator", "overload", "override", "package", "private",
    "public", "return", "static", "switch", "this", "throw", "true", "try",
    "typedef", "untyped", "using", "var", "while",
]);

const identifier = (name: string) => KEYWORDS.has(name) ? `${name}_` : name;

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

    if (prop.quantized) {
        const q = prop.quantized;
        typeArgs += `, {min: ${q.min}, max: ${q.max}, bits: ${q.bits}, mode: ${q.wrap ? 1 : 0}}`;
        langType = "Float";

    } else if (prop.childType) {
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
    }

    // collections and refs are constructed above; scalars start at their default
    if (!initializer) {
        initializer = defaultLiteral(prop.defaultValue, langType) ?? zeroOf(langType);
    }

    const name = identifier(prop.name);
    const wireName = (name !== prop.name) ? `\t// "${prop.name}" on the wire (a Haxe keyword)\n` : "";

    return `${wireName}\t@:type(${typeArgs})\n\tpublic var ${name}: ${langType} = ${initializer};\n`
}

/**
 * A field's statically-known default as a Haxe literal of `langType`, or
 * undefined when there is none (or it doesn't fit the type).
 */
function defaultLiteral(value: Property["defaultValue"], langType: string): string | undefined {
    if (value === undefined) { return undefined; }

    if (typeof value === "boolean") {
        return (langType === "Bool") ? String(value) : undefined;
    }

    if (typeof value === "string") {
        return (langType === "String") ? haxeString(value) : undefined;
    }

    if (langType === "Float") {
        if (Number.isNaN(value)) { return "Math.NaN"; }
        if (!Number.isFinite(value)) { return (value > 0) ? "Math.POSITIVE_INFINITY" : "Math.NEGATIVE_INFINITY"; }
        return String(value);
    }

    if (!Number.isInteger(value)) { return undefined; }

    if (langType === "Int") { return String(value); }

    if (langType === "haxe.Int64") {
        return (Math.abs(value) <= 0x7fffffff) ? String(value) : `haxe.Int64.fromFloat(${value})`;
    }

    return undefined;
}

/**
 * A double-quoted Haxe string literal (double quotes never interpolate `$`):
 * JSON's escapes, except `\b` and `\f`, which Haxe lacks. Escapes are matched
 * in pairs so an escaped backslash followed by `b` stays as it is.
 */
const haxeString = (value: string) =>
    JSON.stringify(value).replace(/\\(.)/g, (escape, ch) => (ch === "b") ? "\\x08" : (ch === "f") ? "\\x0c" : escape);
