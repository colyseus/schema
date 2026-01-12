import { DataChange } from "../DecodeOperation.js";
import { Decoder } from "../Decoder.js";

export function getRawChangesCallback(
    decoder: Decoder,
    callback: (changes: DataChange[]) => void
) {
    decoder.triggerChanges = callback;
}