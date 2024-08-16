
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