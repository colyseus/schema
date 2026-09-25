//
// Must have Symbol.metadata defined for metadata support on decorators:
// https://github.com/microsoft/TypeScript/issues/55453#issuecomment-1687496648
//
export {};
declare global {
    interface SymbolConstructor {
        readonly metadata: unique symbol;
    }
}
(Symbol as any).metadata ??= Symbol.for("Symbol.metadata");

/**
 * Give `ctor` its own `Symbol.metadata` slot, so metadata reads on a class that
 * has none of its own stop here instead of walking up to `Function.prototype`.
 *
 * The TC39 decorator-metadata proposal defines
 * `Function.prototype[Symbol.metadata]` as `null`, and core-js's
 * `esnext.function.metadata` polyfill installs it with a bare `{ value: null }`
 * descriptor — non-writable and non-configurable. On a page loading such a
 * polyfill (`agora-rtc-sdk-ng` bundles one) every inherited read yields `null`
 * rather than `undefined`, and every inherited write throws. Owning the slot
 * keeps both to the values the rest of the codebase is written against.
 *
 * Callers are the two metadata roots: `Schema` (subclasses inherit its slot)
 * and `registerType`, which every collection type is registered through.
 */
export function shadowMetadata(ctor: Function) {
    Object.defineProperty(ctor, (Symbol as any).metadata, {
        value: undefined,
        writable: true,
        configurable: true,
        enumerable: false,
    });
}
