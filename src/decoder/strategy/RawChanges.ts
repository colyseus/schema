import { DataChange } from "../DecodeOperation";
import { Decoder } from "../Decoder";

export function getRawChangesCallback(
    decoder: Decoder,
    callback: (changes: DataChange[]) => void
) {
    decoder.triggerChanges = callback;
}