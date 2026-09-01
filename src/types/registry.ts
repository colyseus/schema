import { DefinitionType, type } from "../annotations.js";
import { BufferLike, encode } from "../encoding/encode.js";
import { decode, Iterator } from "../encoding/decode.js";
import { shadowMetadata } from "../symbol.shim.js";

export interface TypeDefinition {
    constructor?: any,
    encode?: (bytes: BufferLike, value: any, it: Iterator) => any;
    decode?: (bytes: BufferLike, it: Iterator) => any;
}

export const registeredTypes: {[identifier: string] : TypeDefinition} = {};

const identifiers = new Map<any, string>();

export function registerType(identifier: string, definition: TypeDefinition) {
    if (definition.constructor) {
        // Registration is the one choke point every collection type passes
        // through, third-party ones included. hasOwn, because a bare
        // `{ encode, decode }` literal inherits `Object` as its `constructor`;
        // and only when unset, so a Schema subclass keeps its real metadata.
        if (
            Object.prototype.hasOwnProperty.call(definition, "constructor") &&
            definition.constructor[Symbol.metadata] == null
        ) {
            shadowMetadata(definition.constructor);
        }

        identifiers.set(definition.constructor, identifier);
        registeredTypes[identifier] = definition;
    }

    if (definition.encode) { (encode as any)[identifier] = definition.encode; }
    if (definition.decode) { (decode as any)[identifier] = definition.decode; }
}

export function getIdentifier(klass: any): string {
    return identifiers.get(klass);
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