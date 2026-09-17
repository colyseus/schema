import * as ts from "typescript";
import * as path from "path";
import { readFileSync } from "fs";
import { IStructure, Class, Interface, Property, Context, Enum, QuantizedProperty } from "./types.js";
import { ResolveOptions, isOwnPackageSource, resetResolver, resolveNonRelativeImport, resolveSourceFile, sourceFileCandidates } from "./resolve.js";

let currentStructure: IStructure;
let currentProperty: Property;

let globalContext: Context;

let defineTypesWarned = false;

const BUILDER_COLLECTION_KINDS = new Set(["array", "map", "set", "collection"]);

/**
 * For a t.*().chain().calls() expression, walk down to the base `t.X(...)`
 * call and return its method name, first argument, the names of the
 * chained modifiers (`.view()`, `.deprecated()`, …) and the argument of the
 * effective `.default(...)`. Returns null if the node does not look like a
 * builder chain.
 */
function extractBuilderBase(node: ts.CallExpression): { methodName: string, firstArg?: ts.Expression, modifiers: Set<string>, defaultArg?: ts.Expression } | null {
    const modifiers = new Set<string>();
    let defaultArg: ts.Expression | undefined;
    let current: ts.CallExpression = node;
    while (true) {
        const expr = current.expression;
        if (!ts.isPropertyAccessExpression(expr)) {
            return null;
        }
        if (ts.isCallExpression(expr.expression)) {
            // walking outermost-first: the first `.default()` seen is the last applied
            if (expr.name.text === "default" && !modifiers.has("default")) {
                defaultArg = current.arguments[0];
            }
            modifiers.add(expr.name.text);
            current = expr.expression;
            continue;
        }
        return {
            methodName: expr.name.text,
            firstArg: current.arguments[0],
            modifiers,
            defaultArg,
        };
    }
}

/**
 * Collection kind of a message field's type annotation, and the type it holds:
 * - "array" for `T[]`, `readonly T[]`, `Array<T>` or `ReadonlyArray<T>`
 * - "map" for `Record<K, V>`, `Map<K, V>`, `ReadonlyMap<K, V>` or `{ [key: K]: V }`
 *
 * Returns undefined for any other type.
 */
function getCollectionType(node: ts.TypeNode): { type: "array" | "map", child: ts.TypeNode } | undefined {
    if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword) {
        node = node.type;
    }
    if (ts.isArrayTypeNode(node)) {
        return { type: "array", child: node.elementType };
    }
    if (ts.isTypeReferenceNode(node)) {
        const name = node.typeName.getText();
        const args = node.typeArguments;
        if (args?.length === 1 && (name === "Array" || name === "ReadonlyArray")) {
            return { type: "array", child: args[0] };
        }
        if (args?.length === 2 && (name === "Record" || name === "Map" || name === "ReadonlyMap")) {
            return { type: "map", child: args[1] };
        }
    }
    if (ts.isTypeLiteralNode(node) && node.members.length === 1 && ts.isIndexSignatureDeclaration(node.members[0])) {
        return { type: "map", child: node.members[0].type };
    }
    return undefined;
}

/**
 * Statically evaluate a default value: a string/boolean literal or a constant
 * numeric expression, `const`s included (local or imported). Returns
 * undefined for anything else (a factory function, an object).
 */
function evalDefaultLiteral(node: ts.Expression | undefined): string | number | boolean | undefined {
    if (!node) { return undefined; }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) { return node.text; }
    if (node.kind === ts.SyntaxKind.TrueKeyword) { return true; }
    if (node.kind === ts.SyntaxKind.FalseKeyword) { return false; }
    return evalNumericExpression(node, resolveConstIdentifier);
}

/**
 * Statically evaluate a numeric option expression. Codegen has no runtime, so
 * only constant arithmetic is supported: literals, unary +/-, `Math.PI`-style
 * constants and add/sub/mul/div combinations of those (e.g. `Math.PI * 2`).
 * A bare identifier is evaluated through `resolveIdentifier` when given.
 * Returns undefined for anything it cannot resolve (an unresolved reference, a call).
 */
function evalNumericExpression(node: ts.Expression, resolveIdentifier?: (id: ts.Identifier) => number | undefined): number | undefined {
    if (ts.isNumericLiteral(node)) {
        return Number(node.text);
    }
    if (ts.isIdentifier(node)) {
        return resolveIdentifier?.(node);
    }
    if (ts.isParenthesizedExpression(node)) {
        return evalNumericExpression(node.expression, resolveIdentifier);
    }
    if (ts.isPrefixUnaryExpression(node)) {
        const operand = evalNumericExpression(node.operand as ts.Expression, resolveIdentifier);
        if (operand === undefined) { return undefined; }
        if (node.operator === ts.SyntaxKind.MinusToken) { return -operand; }
        if (node.operator === ts.SyntaxKind.PlusToken) { return operand; }
        return undefined;
    }
    if (ts.isPropertyAccessExpression(node) && node.expression.getText() === "Math") {
        const constant = (Math as any)[node.name.text];
        return (typeof constant === "number") ? constant : undefined;
    }
    if (ts.isBinaryExpression(node)) {
        const left = evalNumericExpression(node.left, resolveIdentifier);
        const right = evalNumericExpression(node.right, resolveIdentifier);
        if (left === undefined || right === undefined) { return undefined; }
        switch (node.operatorToken.kind) {
            case ts.SyntaxKind.PlusToken: return left + right;
            case ts.SyntaxKind.MinusToken: return left - right;
            case ts.SyntaxKind.AsteriskToken: return left * right;
            case ts.SyntaxKind.SlashToken: return left / right;
            default: return undefined;
        }
    }
    return undefined;
}

/** Resolve an import/export specifier to a first-party source file. */
function resolveModuleFile(moduleName: string, currentFile: string): string | undefined {
    return (moduleName.startsWith("."))
        ? resolveSourceFile(path.resolve(path.dirname(currentFile), moduleName))
        // may be a tsconfig `paths`/`baseUrl` alias onto first-party source;
        // npm packages are filtered out by the resolver
        : resolveNonRelativeImport(moduleName, currentFile);
}

/**
 * The initializer of the top-level `const` named `name` in `sourceFile` — or of
 * the one it imports (aliased or not) or re-exports under that name. Only
 * `const` resolves: a `let` may be reassigned before `schema()` runs.
 */
function findConstInitializer(name: string, sourceFile: ts.SourceFile, visited = new Set<string>()): ts.Expression | undefined {
    const key = `${sourceFile.fileName}#${name}`;
    if (visited.has(key)) { return undefined; } // `export *` cycle
    visited.add(key);

    const follow = (specifier: ts.Expression, importedName: string) => {
        const file = resolveModuleFile((specifier as ts.StringLiteral).text, sourceFile.fileName);
        return file && findConstInitializer(
            importedName,
            ts.createSourceFile(file, readFileSync(file).toString(), ts.ScriptTarget.Latest, true),
            visited,
        );
    };

    for (const statement of sourceFile.statements) {
        if (ts.isVariableStatement(statement)) {
            if (!(statement.declarationList.flags & ts.NodeFlags.Const)) { continue; }
            const decl = statement.declarationList.declarations.find((d) => ts.isIdentifier(d.name) && d.name.text === name);
            if (decl) { return decl.initializer; }

        } else if (ts.isImportDeclaration(statement)) {
            const bindings = statement.importClause?.namedBindings;
            const spec = (bindings && ts.isNamedImports(bindings))
                ? bindings.elements.find((el) => el.name.text === name)
                : undefined;
            if (spec) { return follow(statement.moduleSpecifier, (spec.propertyName ?? spec.name).text); }

        } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
            // barrels: `export * from "./x"`, `export { A as B } from "./x"`
            const clause = statement.exportClause;
            const spec = (clause && ts.isNamedExports(clause))
                ? clause.elements.find((el) => el.name.text === name)
                : undefined;
            if (!clause || spec) {
                const found = follow(statement.moduleSpecifier, spec ? (spec.propertyName ?? spec.name).text : name);
                if (found) { return found; }
            }
        }
    }
    return undefined;
}

/**
 * Evaluate a `const` reference through its initializer, across imports. `chain`
 * holds the consts mid-evaluation, so a cyclic definition fails instead of
 * recursing forever.
 */
function resolveConstIdentifier(id: ts.Identifier, chain = new Set<string>()): number | undefined {
    const initializer = findConstInitializer(id.text, id.getSourceFile());
    if (!initializer) { return undefined; }

    // file + offset: an imported module is re-parsed per lookup, so nodes differ
    const key = `${initializer.getSourceFile().fileName}:${initializer.pos}`;
    if (chain.has(key)) { return undefined; }

    chain.add(key);
    const value = evalNumericExpression(initializer, (inner) => resolveConstIdentifier(inner, chain));
    chain.delete(key);
    return value;
}

/**
 * Extract `{ min, max, bits?, mode? }` from a `t.quantized({...})` /
 * `@type({ quantized: {...} })` object literal, or the `{ bits? }` of a
 * `t.angle()`. Throws on anything codegen cannot statically resolve — silently
 * dropping an option would generate a client that decodes every value of that
 * field wrong.
 */
function parseQuantizedOptions(node: ts.Expression | undefined, propertyName: string, builder: "quantized" | "angle" = "quantized"): QuantizedProperty {
    const fail = (reason: string): never => {
        throw new Error(
            `schema-codegen: cannot statically resolve t.${builder}() options of field '${propertyName}' — ${reason}. ` +
            `Use literal numbers, constant Math expressions (e.g. \`Math.PI * 2\`) or \`const\`s holding them.`
        );
    };

    const angle = builder === "angle";
    // `t.angle()` may omit its options entirely
    const properties: readonly ts.ObjectLiteralElementLike[] | undefined = (!node && angle)
        ? []
        : (node && ts.isObjectLiteralExpression(node)) ? node.properties : undefined;
    if (!properties) {
        return fail(`expected an inline \`{ ${angle ? "bits" : "min, max, ..."} }\` object literal`);
    }

    // mirrors builder.ts: t.angle({ bits }) ≡ t.quantized({ min: 0, max: Math.PI * 2, mode: "wrap", bits })
    const result: Partial<QuantizedProperty> & { mode?: string } = angle ? { min: 0, max: Math.PI * 2, mode: "wrap" } : {};
    for (const prop of properties) {
        if (!ts.isPropertyAssignment(prop) || !prop.name) { continue; }
        const key = (prop.name as ts.Identifier).text;
        if (angle && key !== "bits") { continue; } // the runtime reads nothing else

        if (key === "mode") {
            if (!ts.isStringLiteral(prop.initializer)) { return fail("`mode` must be a string literal"); }
            result.mode = prop.initializer.text;
        } else if (key === "min" || key === "max" || key === "bits") {
            const value = evalNumericExpression(prop.initializer, resolveConstIdentifier);
            if (value === undefined) { return fail(`\`${key}\` is not a constant expression`); }
            result[key] = value as any;
        }
    }

    if (typeof result.min !== "number" || typeof result.max !== "number") {
        return fail("`min` and `max` are required");
    }

    const bits = result.bits ?? 16;
    if (bits !== 8 && bits !== 16 && bits !== 32) {
        return fail("`bits` must be 8, 16 or 32");
    }

    return { min: result.min, max: result.max, bits, wrap: result.mode === "wrap" };
}

/**
 * Fill `property` from a field's type expression. Returns false for a
 * `.noSync()` field: the runtime gives it no field index, so emitting it would
 * shift every later index on the client.
 */
function defineProperty(property: Property, initializer: any): boolean {
    // Builder-style: t.number(), t.array(Item), t.map(Item).view(), etc.
    if (ts.isCallExpression(initializer)) {
        const base = extractBuilderBase(initializer);
        if (base) {
            if (base.modifiers.has("noSync")) {
                return false;
            }
            property.defaultValue = evalDefaultLiteral(base.defaultArg);

            // same as `@deprecated()`: `.deprecated(false)` still marks the field
            if (base.modifiers.has("deprecated")) {
                property.deprecated = true;
            }
            if (BUILDER_COLLECTION_KINDS.has(base.methodName)) {
                property.type = base.methodName;
                if (base.firstArg) {
                    // see through `(x)`, `x as any`, `x satisfies T`
                    let childArg: ts.Expression = base.firstArg;
                    while (ts.isParenthesizedExpression(childArg) || ts.isAsExpression(childArg) || ts.isSatisfiesExpression(childArg)) {
                        childArg = childArg.expression;
                    }
                    if (ts.isCallExpression(childArg)) {
                        // mirrors the runtime guard in builder.ts resolveChild()
                        const inner = extractBuilderBase(childArg);
                        const hint = (inner && !BUILDER_COLLECTION_KINDS.has(inner.methodName) && inner.methodName !== "ref" && inner.methodName !== "quantized" && inner.methodName !== "angle")
                            ? `use the type name instead: t.${base.methodName}("${inner.methodName}")`
                            : `collections accept a Schema class or a primitive type name ("string", "number", …)`;
                        throw new Error(`schema-codegen: field '${property.name}': a t.* builder is not a valid element type — ${hint}.`);
                    }
                    property.childType = (childArg as any).text ?? childArg.getText();
                }
            } else if (base.methodName === "ref") {
                property.type = "ref";
                if (base.firstArg) {
                    property.childType = (base.firstArg as any).text ?? base.firstArg.getText();
                }
            } else if (base.methodName === "quantized" || base.methodName === "angle") {
                property.type = "quantized";
                property.quantized = parseQuantizedOptions(base.firstArg, property.name, base.methodName);
            } else {
                property.type = base.methodName;
            }
            return true;
        }
    }

    if (ts.isIdentifier(initializer)) {
        property.type = "ref";
        property.childType = initializer.text;

    } else if (initializer.kind == ts.SyntaxKind.ObjectLiteralExpression) {
        if (initializer.properties[0].name.text === "quantized") {
            // decorator-style: @type({ quantized: { min, max, ... } })
            property.type = "quantized";
            property.quantized = parseQuantizedOptions(initializer.properties[0].initializer, property.name);
        } else {
            property.type = initializer.properties[0].name.text;
            property.childType = initializer.properties[0].initializer.text;
        }

    } else if (initializer.kind == ts.SyntaxKind.ArrayLiteralExpression) {
        property.type = "array";
        property.childType = initializer.elements[0].text;

    } else {
        property.type = initializer.text;
    }
    return true;
}

function followModuleSpecifier(
    specifier: ts.Expression | undefined,
    currentFile: string,
    decoratorName: string,
) {
    const moduleName: string | undefined = (specifier as ts.StringLiteral)?.text;
    if (!moduleName) { return; } // `export { x }` — no module to follow

    const resolved = resolveModuleFile(moduleName, currentFile);
    if (resolved && !isOwnPackageSource(resolved)) {
        parseFiles([resolved], decoratorName, globalContext);
    }
}

function inspectNode(node: ts.Node, context: Context, decoratorName: string) {
    switch (node.kind) {
        case ts.SyntaxKind.ImportDeclaration:
        case ts.SyntaxKind.ExportDeclaration:
            // ExportDeclaration too: path aliases usually point at a barrel
            // (`@schemas` -> `schemas/index.ts` -> `export * from "./Player"`).
            followModuleSpecifier(
                (node as ts.ImportDeclaration | ts.ExportDeclaration).moduleSpecifier,
                node.getSourceFile().fileName,
                decoratorName,
            );
            break;

        case ts.SyntaxKind.ClassDeclaration:
            currentStructure = new Class();

            const heritageClauses = (node as ts.ClassLikeDeclarationBase).heritageClauses;
            if (heritageClauses && heritageClauses.length > 0) {
                (currentStructure as Class).extends = heritageClauses[0].types[0].expression.getText();
            }

            context.addStructure(currentStructure);
            break;

        case ts.SyntaxKind.InterfaceDeclaration:
            //
            // Only generate Interfaces if it has "Message" on its name.
            // Example: MyMessage
            //
            const interfaceName = (node as ts.TypeParameterDeclaration).name.escapedText.toString();
            if (interfaceName.indexOf("Message") !== -1) {
                currentStructure = new Interface();
                currentStructure.name = interfaceName;

                context.addStructure(currentStructure);
            }
            break;

        case ts.SyntaxKind.EnumDeclaration:
            const enumName = (
                node as ts.EnumDeclaration
            ).name.escapedText.toString();
            currentStructure = new Enum();
            currentStructure.name = enumName;
            context.addStructure(currentStructure);
            break;

        case ts.SyntaxKind.ExtendsKeyword:
            // console.log(node.getText());
            break;

        case ts.SyntaxKind.PropertySignature:
            if (currentStructure instanceof Interface) {
                const parent = node.parent;

                // Only process direct children of InterfaceDeclaration, skip TypeLiterals
                if (!ts.isInterfaceDeclaration(parent)) {
                    break;
                }

                // Skip if property if for a another interface than the one we're interested in.
                if (currentStructure.name !== parent.name.escapedText.toString()) {
                    break;
                }

                // define a property of an interface
                const signature = node as ts.PropertySignature;
                const collection = getCollectionType(signature.type);

                const property = new Property();
                property.name = (signature.name as ts.Identifier).escapedText.toString();
                property.type = collection?.type ?? signature.type.getText();
                property.childType = collection?.child.getText();
                currentStructure.addProperty(property);
            }
            break;

        case ts.SyntaxKind.Identifier:
            if (
                node.getText() === "deprecated" &&
                node.parent.kind !== ts.SyntaxKind.ImportSpecifier
            ) {
                currentProperty = new Property();
                currentProperty.deprecated = true;
                break;
            }

            if (node.getText() === decoratorName) {
                const prop: any = node.parent?.parent?.parent;
                const propDecorator = getDecorators(prop);
                const hasExpression = prop?.expression?.arguments;
                const hasDecorator = (propDecorator?.length > 0);

                /**
                 * neither a `@type()` decorator or `type()` call. skip.
                 */
                if (!hasDecorator && !hasExpression) {
                    break;
                }

                // using as decorator
                if (propDecorator) {
                    /**
                     * Calling `@type()` as decorator
                     */
                    const typeDecorator: any = propDecorator.find((decorator => {
                        return (decorator.expression as any).expression.escapedText === decoratorName;
                    })).expression;

                    const property = currentProperty || new Property();
                    property.name = prop.name.escapedText;

                    const typeArgument = typeDecorator.arguments[0];
                    if (defineProperty(property, typeArgument)) {
                        // `@type("string") name = "x"` — the decorator form of `.default()`
                        if (property.defaultValue === undefined) {
                            property.defaultValue = evalDefaultLiteral(prop.initializer);
                        }
                        currentStructure.addProperty(property);
                    }

                } else if (
                    prop.expression.arguments?.[1] &&
                    prop.expression.expression.arguments?.[0]
                ) {
                    /**
                     * Calling `type()` as a regular method
                     */
                    const property = currentProperty || new Property();
                    property.name = prop.expression.arguments[1].text;

                    const typeArgument = prop.expression.expression.arguments[0];
                    if (defineProperty(property, typeArgument)) {
                        currentStructure.addProperty(property);
                    }
                }

            } else if (
                node.getText() === "setFields" &&
                (
                    node.parent.kind === ts.SyntaxKind.CallExpression ||
                    node.parent.kind === ts.SyntaxKind.PropertyAccessExpression
                )
            ) {
                /**
                 * Metadata.setFields(klassName, { ... })
                 */
                const callExpression = (node.parent.kind === ts.SyntaxKind.PropertyAccessExpression)
                    ? node.parent.parent as ts.CallExpression
                    : node.parent as ts.CallExpression;

                /**
                 * Skip if @codegen-ignore comment is found before the call expression
                 * TODO: currently, if @codegen-ignore is on the file, it will skip all the setFields calls.
                 */
                const sourceFile = node.getSourceFile();
                const fullText = sourceFile.getFullText();
                const nodeStart = callExpression.getFullStart();
                const textBeforeNode = fullText.substring(0, nodeStart);
                if (textBeforeNode.includes('@codegen-ignore')) {
                    break;
                }

                if (callExpression.kind !== ts.SyntaxKind.CallExpression) {
                    break;
                }

                const classNameNode = callExpression.arguments[0];
                const className = ts.isClassExpression(classNameNode)
                    ? classNameNode.name?.escapedText.toString()
                    : classNameNode.getText();

                // skip if no className is provided
                if (!className) { break; }

                if (currentStructure?.name !== className) {
                    currentStructure = new Class();
                }
                context.addStructure(currentStructure);
                (currentStructure as Class).extends = "Schema"; // force extends to Schema
                currentStructure.name = className;

                const types = callExpression.arguments[1] as any;
                for (let i = 0; i < types.properties.length; i++) {
                    const prop = types.properties[i];

                    const property = currentProperty || new Property();
                    property.name = prop.name.escapedText;

                    if (defineProperty(property, prop.initializer)) {
                        currentStructure.addProperty(property);
                    }
                }

            } else if (
                node.getText() === "defineTypes" &&
                (
                    node.parent.kind === ts.SyntaxKind.CallExpression ||
                    node.parent.kind === ts.SyntaxKind.PropertyAccessExpression
                )
            ) {
                /**
                 * JavaScript source file (`.js`)
                 * Using `defineTypes()` (deprecated)
                 */
                const callExpression = (node.parent.kind === ts.SyntaxKind.PropertyAccessExpression)
                    ? node.parent.parent as ts.CallExpression
                    : node.parent as ts.CallExpression;

                if (callExpression.kind !== ts.SyntaxKind.CallExpression) {
                    break;
                }

                if (!defineTypesWarned) {
                    defineTypesWarned = true;
                    console.warn("schema-codegen: defineTypes() is deprecated and will be removed in a future release. Use schema() with t.* field builders instead → https://docs.colyseus.io/state/schema");
                }

                const className = callExpression.arguments[0].getText()
                currentStructure.name = className;

                const types = callExpression.arguments[1] as any;
                for (let i = 0; i < types.properties.length; i++) {
                    const prop = types.properties[i];

                    const property = currentProperty || new Property();
                    property.name = prop.name.escapedText;

                    if (defineProperty(property, prop.initializer)) {
                        currentStructure.addProperty(property);
                    }
                }

            }

            if (node.parent.kind === ts.SyntaxKind.ClassDeclaration) {
                currentStructure.name = node.getText();
            }

            currentProperty = undefined;

            break;

        case ts.SyntaxKind.CallExpression:
            /**
             * Defining schema via:
             * - schema({ ... })
             * - schema({ ... }, 'Name')
             * - schema.schema({ ... }, 'Name')
             * - ParentClass.extend({ ... }, 'Name')
             */
            {
                const callExpression = node as ts.CallExpression;
                const callee = callExpression.expression?.getText?.();
                if (!callee) break;

                const isSchemaCall = callee === "schema" || callee === "schema.schema";
                const isExtendCall = callee.endsWith(".extend");
                if (!isSchemaCall && !isExtendCall) break;

                // Signature: (fields, name?)
                const fieldsArg = callExpression.arguments[0];
                const nameArg = callExpression.arguments[1];
                if (!fieldsArg || fieldsArg.kind !== ts.SyntaxKind.ObjectLiteralExpression) {
                    break;
                }

                let className: string | undefined;
                if (nameArg) {
                    if (nameArg.kind === ts.SyntaxKind.StringLiteral) {
                        className = (nameArg as ts.StringLiteral).text;
                    } else {
                        className = nameArg.getText();
                    }
                }

                if (!className) {
                    // No explicit name arg — infer it from the variable the
                    // result is assigned to (`const Foo = schema({...})`).
                    let p: ts.Node = callExpression.parent;
                    while (p !== undefined && (
                        p.kind === ts.SyntaxKind.PropertyAccessExpression ||
                        p.kind === ts.SyntaxKind.CallExpression
                    )) {
                        p = p.parent;
                    }
                    if (p?.kind === ts.SyntaxKind.VariableDeclaration) {
                        className = (p as ts.VariableDeclaration).name?.getText();
                    }
                }

                if (!className) break;

                // Resolve the base class BEFORE registering a structure. A
                // chained `schema({...}).extend({...})` has a call expression
                // (not an identifier) as its `.extend` base, which can't be
                // statically named — bail here rather than leave a half-formed,
                // nameless Class in the context (which corrupts inheritance walks).
                let extendsClass = "Schema";
                if (isExtendCall) {
                    extendsClass = (node as any).expression?.expression?.escapedText;
                    if (!extendsClass) {
                        console.warn(`schema-codegen: cannot resolve the base class of a chained .extend() for '${className}' — fields from that .extend({...}) are omitted.`);
                        break;
                    }
                }

                if (currentStructure?.name !== className) {
                    currentStructure = new Class();
                    context.addStructure(currentStructure);
                }

                (currentStructure as Class).extends = extendsClass;
                currentStructure.name = className;

                const types = fieldsArg as any;
                for (let i = 0; i < types.properties.length; i++) {
                    const prop = types.properties[i];

                    // Skip methods declared inside the fields object — the
                    // runtime gives no field index to any function value.
                    if (prop.kind === ts.SyntaxKind.MethodDeclaration) continue;
                    if (!prop.initializer) continue;
                    if (ts.isArrowFunction(prop.initializer) || ts.isFunctionExpression(prop.initializer)) continue;

                    // never inherit `currentProperty`: it's the decorator path's
                    // carry-over from a visited `deprecated` identifier, and a
                    // trailing `.deprecated()` chain can leave it set
                    const property = new Property();
                    property.name = prop.name.escapedText;

                    if (defineProperty(property, prop.initializer)) {
                        currentStructure.addProperty(property);
                    }
                }
            }

            break;

        case ts.SyntaxKind.EnumMember:
            if (currentStructure instanceof Enum) {
                const initializer = (node as any).initializer?.text;
                const name = node.getFirstToken().getText();
                const property = currentProperty || new Property();
                property.name = name;
                if (initializer !== undefined) {
                    property.type = initializer;
                }
                currentStructure.addProperty(property);
                currentProperty = undefined;
            }
            break;
    }

    ts.forEachChild(node, (n: ts.Node) => inspectNode(n, context, decoratorName));
}

let parsedFiles: { [filename: string]: boolean };

/**
 * `options` is only honored for a top-level call (one passing a fresh
 * `Context`) — the recursive import walk reuses the run's resolver state.
 */
export function parseFiles(
    fileNames: string[],
    decoratorName: string = "type",
    context: Context = new Context(),
    options?: ResolveOptions,
) {
    if (typeof ts.createSourceFile !== "function") {
        // typescript@7+ (native) no longer ships the JS compiler API
        throw new Error(
            `schema-codegen requires the TypeScript compiler API, which the installed "typescript@${(ts as any).version}" package does not provide.\n` +
            `TypeScript 7+ no longer ships the JS compiler API — install typescript 5.x or 6.x (e.g. \`npm install --save-dev typescript@6\`) to use schema-codegen.`
        );
    }

    /**
     * Re-set globalContext for each test case
     */
    if (globalContext !== context) {
        parsedFiles = {};
        globalContext = context;
        // a structure left over from a previous run would make the
        // `currentStructure?.name !== className` guard skip re-registering it
        currentStructure = undefined;
        currentProperty = undefined;
        resetResolver(options);
    }

    fileNames.forEach((fileName) => {
        let sourceFile: ts.Node;
        let sourceFileName: string;

        const fileNameAlternatives = sourceFileCandidates(fileName);

        for (let i = 0; i < fileNameAlternatives.length; i++) {
            try {
                sourceFileName = path.resolve(fileNameAlternatives[i]);

                if (parsedFiles[sourceFileName]) {
                    break;
                }

                sourceFile = ts.createSourceFile(
                    sourceFileName,
                    readFileSync(sourceFileName).toString(),
                    ts.ScriptTarget.Latest,
                    true
                );

                parsedFiles[sourceFileName] = true;

                break;
            } catch (e) {
                // only swallow fs errors (ENOENT/EISDIR) while probing alternatives
                if (!e?.code) { throw e; }
            }
        }

        if (sourceFile) {
            inspectNode(sourceFile, context, decoratorName);
        }
    });

    return context.getStructures();
}

/**
 * TypeScript 4.8+ has introduced a change on how to access decorators.
 * - https://github.com/microsoft/TypeScript/pull/49089
 * - https://devblogs.microsoft.com/typescript/announcing-typescript-4-8/#decorators-are-placed-on-modifiers-on-typescripts-syntax-trees
 */
export function getDecorators(node: ts.Node | null | undefined,): undefined | ts.Decorator[] {
    if (node == undefined) { return undefined; }

    // TypeScript 4.7 and below
    // @ts-ignore
    if (node.decorators) { return node.decorators; }

    // TypeScript 4.8 and above
    // @ts-ignore
    if (ts.canHaveDecorators && ts.canHaveDecorators(node)) {
        // @ts-ignore
        const decorators = ts.getDecorators(node);
        return decorators ? Array.from(decorators) : undefined;
    }

    // @ts-ignore
    return node.modifiers?.filter(ts.isDecorator);
}
