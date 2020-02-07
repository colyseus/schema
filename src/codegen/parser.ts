import * as ts from "typescript";
import * as path from "path";
import { readFileSync } from "fs";
import { Class, Property, Context } from "./types";

let currentClass: Class;
let currentProperty: Property;

let globalContext: Context;

function defineProperty(property: Property, initializer: any) {
    if (ts.isIdentifier(initializer)) {
        property.type = "ref";
        property.childType = initializer.text;

    } else if (initializer.kind == ts.SyntaxKind.ObjectLiteralExpression) {
        property.type = "map";
        property.childType = initializer.properties[0].initializer.text;

    } else if (initializer.kind == ts.SyntaxKind.ArrayLiteralExpression) {
        property.type = "array";
        property.childType = initializer.elements[0].text;

    } else {
        property.type = initializer.text;
    }
}

function inspectNode(node: ts.Node, context: Context, decoratorName: string) {
    switch (node.kind) {
        case ts.SyntaxKind.ImportClause:
            const specifier = (node.parent as any).moduleSpecifier;
            if (specifier && (specifier.text as string).startsWith('.'))  {
                const currentDir = path.dirname(node.getSourceFile().fileName);
                const pathToImport = path.resolve(currentDir, specifier.text);
                parseFiles([pathToImport], decoratorName, globalContext);
            }
            break;

        case ts.SyntaxKind.ClassDeclaration:
            currentClass = new Class();

            const heritageClauses = (node as ts.ClassLikeDeclarationBase).heritageClauses;
            if (heritageClauses && heritageClauses.length > 0) {
                currentClass.extends = heritageClauses[0].types[0].expression.getText();
            }

            context.addClass(currentClass);
            break;

        case ts.SyntaxKind.ExtendsKeyword:
            // console.log(node.getText());
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
                const prop: any = node.parent.parent.parent;
                const propDecorator = node.parent.parent.parent.decorators;
                const hasExpression = prop.expression && prop.expression.arguments;

                /**
                 * neither a `@type()` decorator or `type()` call. skip.
                 */
                if (!propDecorator && !hasExpression) {
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
                    currentClass.addProperty(property);

                    const typeArgument = typeDecorator.arguments[0];
                    defineProperty(property, typeArgument);

                } else if (
                    prop.expression.arguments &&
                    prop.expression.arguments[1] &&
                    prop.expression.expression.arguments &&
                    prop.expression.expression.arguments[0]
                ) {
                    /**
                     * Calling `type()` as a regular method
                     */
                    const property = currentProperty || new Property();
                    property.name = prop.expression.arguments[1].text;
                    currentClass.addProperty(property);

                    const typeArgument = prop.expression.expression.arguments[0];
                    defineProperty(property, typeArgument);
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
                 * Using `defineTypes()`
                 */
                const callExpression = (node.parent.kind === ts.SyntaxKind.PropertyAccessExpression)
                    ? node.parent.parent as ts.CallExpression
                    : node.parent as ts.CallExpression;

                if (callExpression.kind !== ts.SyntaxKind.CallExpression) {
                    break;
                }

                const className = callExpression.arguments[0].getText()
                currentClass.name = className;

                const types = callExpression.arguments[1] as any;
                for (let i=0; i<types.properties.length; i++) {
                    const prop = types.properties[i];

                    const property = currentProperty || new Property();
                    property.name = prop.name.escapedText;
                    currentClass.addProperty(property);

                    defineProperty(property, prop.initializer);
                }

            }

            if (node.parent.kind === ts.SyntaxKind.ClassDeclaration) {
                currentClass.name = node.getText();
            }

            currentProperty = undefined;

            break;
    }

    ts.forEachChild(node, (n) => inspectNode(n, context, decoratorName));
}

let parsedFiles: { [filename: string]: boolean };

export function parseFiles(fileNames: string[], decoratorName: string = "type", context: Context = new Context()): Class[] {
    /**
     * Re-set globalContext for each test case
     */
    if (globalContext !== context) {
        parsedFiles = {};
        globalContext = context;
    }

    fileNames.forEach((fileName) => {
        let sourceFile: ts.Node;
        let sourceFileName: string;

        const fileNameAlternatives = [];

        if (!fileName.endsWith(".ts") && !fileName.endsWith(".js")) {
            fileNameAlternatives.push(`${fileName}.ts`);
            fileNameAlternatives.push(`${fileName}/index.ts`);

        } else {
            fileNameAlternatives.push(fileName);
        }

        for (let i = 0; i < fileNameAlternatives.length; i++) {
            try {
                sourceFileName = path.resolve(fileNameAlternatives[i]);

                if (parsedFiles[sourceFileName]) {
                    break;
                }

                sourceFile = ts.createSourceFile(sourceFileName, readFileSync(sourceFileName).toString(), ts.ScriptTarget.Latest, true);
                parsedFiles[sourceFileName] = true;

                break;
            } catch (e) {
                // console.log(`${fileNameAlternatives[i]} => ${e.message}`);
            }
        }

        if (sourceFile) {
            inspectNode(sourceFile, context, decoratorName);
        }
    });

    return context.getSchemaClasses();
}