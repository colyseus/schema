/**
 * The public `Encoder` export. Loading this module turns on change tracking
 * for every instance constructed from then on (see `createTree`).
 *
 * The build ships it alone in `chunks/encoder.mjs`, which
 * `package.json#sideEffects` leaves out: a bundle that never imports `Encoder`
 * drops it, and with nothing else constructing a `ChangeTree`, the change
 * tracking goes too. `Encoder` itself stays in the shared chunk with the code
 * its hot loops call: references across chunks are imported bindings, which
 * cost encode ticks ~2–5%.
 */
import type { Schema } from "../Schema.js";
import { ChangeTree, installTracking } from "./ChangeTree.js";
import { ensureTracked } from "./changeTree/treeAttachment.js";
import { Encoder as EncoderClass } from "./Encoder.js";

installTracking((ref) => new ChangeTree(ref), ensureTracked);

// A binding of this module's own: a plain re-export would let rollup point
// `index.mjs` at the shared chunk and import this file only for its side
// effect, an import `sideEffects` lets bundlers drop even when `Encoder` is used.
export const Encoder = EncoderClass;
export type Encoder<T extends Schema = any> = EncoderClass<T>;
