import { DefinitionType, type } from "../annotations.js";
import { BufferLike, encode } from "../encoding/encode.js";
import { decode, Iterator } from "../encoding/decode.js";

export interface TypeDefinition {
    constructor?: any,
    encode?: (bytes: BufferLike, value: any, it: Iterator) => any;
    decode?: (bytes: BufferLike, it: Iterator) => any;
}

export const registeredTypes: {[identifier: string] : TypeDefinition} = {};

export function registerType(identifier: string, definition: TypeDefinition) {
    if (definition.constructor) {
        registeredTypes[identifier] = definition;
    }

    if (definition.encode) { (encode as any)[identifier] = definition.encode; }
    if (definition.decode) { (decode as any)[identifier] = definition.decode; }
}

export function getType(identifier: string): TypeDefinition {
    return registeredTypes[identifier];
}

export function defineCustomTypes<T extends {[key: string]: TypeDefinition}>(types: T) {
    for (const identifier in types) {
        registerType(identifier, types[identifier]);
    }

    return (t: keyof T) => type(t as DefinitionType);
}