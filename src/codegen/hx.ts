import { Class, Property, File } from "./types";

/**
 * Haxe Code Generator
 */

export function generate (classes: Class[], args: any): File[] {
    throw new Error("Haxe code generator not implemented.");
    return [];
}

function generateClass(klass: Class, namespace: string) {
}

function generateProperty(prop: Property, indent: string = "") {
}