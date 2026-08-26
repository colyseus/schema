import { MapSchema } from "../../build/index.js";

const schema = new MapSchema<number>();
const map: Map<string, number> = schema;
const iterator: ReturnType<Map<string, number>[typeof Symbol.iterator]> = schema[Symbol.iterator]();

void map;
void iterator;
