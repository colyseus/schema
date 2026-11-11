// Default typing: writing an ArraySchema by index or through `length` does
// not compile — those writes are untracked without `enableLegacyCompat()`.
import { ArraySchema } from "../../build/index.js";

const numbers = new ArraySchema<number>(1, 2, 3);

const first: number = numbers[0];
const length: number = numbers.length;
const plain: number[] = numbers;
void first; void length; void plain;

numbers.set(0, 10);

const joined: number[] = numbers.concat([4, 5]);
const replaced: number[] = numbers.with(0, 1);
void joined; void replaced;
// @ts-expect-error — a plain array has no ArraySchema methods
numbers.concat([4]).toArray();

// @ts-expect-error — index writes are read-only
numbers[0] = 10;
// @ts-expect-error — so is `length`
numbers.length = 0;
