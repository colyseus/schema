import * as fs from "fs";

const VERSION = JSON.parse(fs.readFileSync(__dirname + "/../../package.json").toString()).version;
const COMMENT_HEADER = `
THIS FILE HAS BEEN GENERATED AUTOMATICALLY
DO NOT CHANGE IT MANUALLY UNLESS YOU KNOW WHAT YOU'RE DOING

GENERATED USING @colyseus/schema ${VERSION}
`;

export function getCommentHeader(singleLineComment: string = "//") {
    return `${COMMENT_HEADER.split("\n").map(line => `${singleLineComment} ${line}`).join("\n")}`;
}

export class Context {
    classes: Class[] = [];

    addClass(currentClass: Class) {
        currentClass.context = this;
        this.classes.push(currentClass);
    }
}

export class Class {
    context: Context;
    name: string;
    properties: Property[] = [];
    extends: string;

    addProperty(property: Property) {
        let parentKlass: Class = this;
        property.index = this.properties.length;

        while ((parentKlass = this.context.classes.find(k => k.name === parentKlass.extends))) {
            property.index += parentKlass.properties.length;
        }

        this.properties.push(property);
    }
}

export class Property {
    index: number;
    name: string;
    type: string;
    childType: string;
}

export interface File {
    name: string
    content: string;
}