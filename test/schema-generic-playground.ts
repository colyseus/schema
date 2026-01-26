export function schema<
    T extends Record<string, any>,
    InitProps
>(
    fieldsAndMethods: T & ThisType<T>,
): T & { initialize: (props: InitProps) => void } {
    return { ...fieldsAndMethods, initialize: (props: InitProps) => { } };
}

const NoInit = schema({
    x: "number",
    initialize() { }
});

const WithInit = schema({
    x: { type: "number", default: 10 },
    initialize(props: { x: number }) {
        this.x.default = props.x;
    }
});


/*
export function schema<
    InitProps,
    T extends Record<string, any>
>(
    fields: T
): T & { initialize: (props: InitProps) => void };

export function schema<
    T extends Record<string, any>
>(
    fields: T
): T & { initialize: (props: never) => void };

export function schema<
    InitProps = any,
    T extends Record<string, any> = any
>(
    fields: T,
    name?: string
): T & { initialize: (props: any) => void } {
    return { ...fields, initialize: () => { } };
}

const NoInit = schema({
    x: "number",
    initialize() { }
});

const WithInit = schema<{ x: number }>({
    x: { type: "number", default: 10 },
});
*/