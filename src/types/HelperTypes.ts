export type NonFunctionPropKeys<T> = keyof NonFunctionProps<T>;

export type NonFunctionProps<T> = Omit<T, {
    [K in keyof T]: T[K] extends Function ? K : never;
}[keyof T]>;

export type NonFunctionPropNames<T> = {
    [K in keyof T]: T[K] extends Function ? never : K
}[keyof T];

export type ToJSON<T> = T extends {
    toJSON(): unknown
} ? ReturnType<T['toJSON']> : T