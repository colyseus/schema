// Covers all enum shapes for C# codegen:
// - implicit (index) int  -> native enum
// - explicit positive int -> native enum
// - string values         -> struct with string const
// - float values          -> struct with float const

export enum ImplicitInt {
    A,
    B,
    C,
}

export enum ExplicitInt {
    X = 10,
    Y = 20,
    Z = 30,
}

export enum StringEnum {
    Foo = "foo",
    Bar = "bar",
}

export enum FloatEnum {
    Half = 0.5,
    One = 1,
    OneAndHalf = 1.5,
}
