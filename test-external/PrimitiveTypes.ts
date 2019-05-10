import { Schema, type } from "../src";

class PrimitiveTypes extends Schema {
  @type("int8") int8: number;
  @type("uint8") uint8: number;

  @type("int16") int16: number;
  @type("uint16") uint16: number;

  @type("int32") int32: number;
  @type("uint32") uint32: number;

  @type("int64") int64: number;
  @type("uint64") uint64: number;

  @type("float32") float32: number;
  @type("float64") float64: number;

  @type("number") varint: number;

  @type("string") string: string;
  @type("boolean") boolean: boolean;
}

const state = new PrimitiveTypes();
state.int8 = -128;
state.uint8 = 255;
state.int16 = -32768;
state.uint16 = 65535;
state.int32 = -2147483648;
state.uint32 = 4294967295;
state.int64 = -9223372036854775808;
state.uint64 = 18446744073709551615;
state.float32 = -3.40282347e+38;
state.float64 = 1.7976931348623157e+308;

const bytes = Array.from(Uint8Array.from(Buffer.from( state.encode() )));

console.log("PrimitiveTypes =>");
console.log(`{ ${bytes.join(", ")} }`);