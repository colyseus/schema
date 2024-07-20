import { ArraySchema, CollectionSchema, MapSchema, Schema, SetSchema, ToJSON, type } from "../../src";
import { Equals } from "../helpers/Equals";

// Reused across multiple tests
export class VecSchema extends Schema {
    @type('number') x: number
    @type('number') y: number
}

describe("ToJSON type tests", () => {
    it("Omits methods", () => {
        class C extends Schema {
            @type('number') time: number
            rewind(arg: number){}
        }
        const _t1: Equals<ToJSON<C>, {
            time: number
        }> = true
    })

    it("Does not transform primitive types", () => {
        // Primitive types have methods, and these should not be omitted
        const _tString: Equals<ToJSON<string>, string> = true
        const _tNumber: Equals<ToJSON<number>, number> = true
        const _tBoolean: Equals<ToJSON<boolean>, boolean> = true
        const _tBigInt: Equals<ToJSON<bigint>, bigint> = true
        const _tSymbol: Equals<ToJSON<symbol>, symbol> = true
        const _tUndefined: Equals<ToJSON<undefined>, undefined> = true
        const _tNull: Equals<ToJSON<null>, null> = true
    })

    it("Does not transform non-schema types", () => {
        class C extends Schema {
            time: number
            pos: { x: number, y: number }
        }
        const _t1: Equals<ToJSON<C>, {
            time: number
            pos: { x: number, y: number }
        }> = true
        const _t2: ToJSON<C> = {
            time: 1,
            pos: { x: 1, y: 2 }
        }
    })

    it("Primitive type on root", () => {
        class C extends Schema {
            @type('number') time: number
            @type('string') name: string
        }
        const _t1: Equals<ToJSON<C>, {
            time: number
            name: string
        }> = true
        const _t2: ToJSON<C> = {
            time: 1,
            name: "name"
        }
    })

    it("Schema type on root", () => {
        class C extends Schema {
            @type(VecSchema) ballPos: VecSchema
        }
        const _t1: Equals<ToJSON<C>, {
            ballPos: {
                x: number
                y: number
            }
        }> = true
        const _t2: ToJSON<C> = {
            ballPos: {
                x: 1,
                y: 2
            }
        }
    })

    it("Map on root", () => {
        class C extends Schema {
            @type({map: VecSchema}) positions: MapSchema<VecSchema>
        }
        const _t1: Equals<ToJSON<C>, {
            positions: Record<string, {
                x: number
                y: number
            }>
        }> = true
        const _t2: ToJSON<C> = {
            positions: {
                a: {
                    x: 1,
                    y: 2
                }
            }
        }
    })

    it("MapSchema on root", () => {
        class C extends Schema {
            @type({map: VecSchema}) positions: MapSchema<VecSchema>
        }
        const _t1: Equals<ToJSON<C>, {
            positions: Record<string, {
                x: number
                y: number
            }>
        }> = true
        const _t2: ToJSON<C> = {
            positions: {
                a: {
                    x: 1,
                    y: 2
                }
            }
        }
    })

    it("ArraySchema on root", () => {
        class C extends Schema {
            @type({map: VecSchema}) positions: ArraySchema<VecSchema>
        }
        const _t1: Equals<ToJSON<C>, {
            positions: Array<{
                x: number
                y: number
            }>
        }> = true
        const _t2: ToJSON<C> = {
            positions: [{
                x: 1,
                y: 2
            }]
        }
    })

    it("SetSchema on root", () => {
        class C extends Schema {
            @type({map: VecSchema}) positions: SetSchema<VecSchema>
        }
        const _t1: Equals<ToJSON<C>, {
            positions: Array<{
                x: number
                y: number
            }>
        }> = true
        const _t2: ToJSON<C> = {
            positions: [{
                x: 1,
                y: 2
            }]
        }
    })

    it("CollectionSchema on root", () => {
        class C extends Schema {
            @type({map: VecSchema}) positions: CollectionSchema<VecSchema>
        }
        const _t1: Equals<ToJSON<C>, {
            positions: Array<{
                x: number
                y: number
            }>
        }> = true
        const _t2: ToJSON<C> = {
            positions: [{
                x: 1,
                y: 2
            }]
        }
    })
})