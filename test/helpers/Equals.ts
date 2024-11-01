// Used to check if two types are equal.
// If they are equal, the expression evaluates to true, otherwise false
export type Equals<T1, T2> = T1 extends T2
    ? T2 extends T1
        ? true
        : false
    : false