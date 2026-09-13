// Bounds live in a shared constants module, the way a real project keeps them —
// codegen has no runtime, so it must follow the import to read them.
export const PITCH_LIMIT = 1.5;
export const PITCH_SPAN = PITCH_LIMIT + PITCH_LIMIT; // same-module chain, referenced twice
export const COARSE_BITS = 8;
