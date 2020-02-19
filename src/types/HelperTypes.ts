type Bool = 'true' | 'false'
type Key = string | number | symbol;

type Not<X extends Bool> = {
    true: 'false',
    false: 'true'
}[X]

type HaveIntersection<S1 extends string, S2 extends string> = (
    { [K in S1]: 'true' } &
    { [key: string]: 'false' }
)[S2]

type IsNeverWorker<S extends Key> = (
    { [K in S]: 'false' } &
    { [key: string]: 'true' }
)[S]

// Worker needed because of https://github.com/Microsoft/TypeScript/issues/18118
type IsNever<T extends Key> = Not<HaveIntersection<IsNeverWorker<T>, 'false'>>

type IsFunction<T> = IsNever<keyof T>

export type NonFunctionProps<T> = {
    [K in keyof T]: {
        'false': K,
        'true': never
    }[IsFunction<T[K]>]
}[keyof T];

export type NonFunctionPropNames<T> = {
    [K in keyof T]: T[K] extends Function ? never : K
}[keyof T];

