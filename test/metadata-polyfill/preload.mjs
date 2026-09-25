//
// core-js's `esnext.function.metadata`, reproduced exactly: the TC39
// decorator-metadata proposal defines `Function.prototype[Symbol.metadata]` as
// `null`, and core-js installs it with a bare `{ value: null }` descriptor —
// non-writable, non-configurable. Preloaded before `src/` so every class in the
// package is defined under the polluted prototype.
//
Symbol.metadata ??= Symbol.for("Symbol.metadata");
Object.defineProperty(Function.prototype, Symbol.metadata, { value: null });
