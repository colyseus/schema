import { Schema, Metadata } from "../../../src";

// the 3rd party structure...
class Vec3 {
    x: number;
    y: number;
    z: number;
}

// define how to encode the properties
Metadata.setFields(Vec3, {
    x: "number",
    y: "number",
    z: "number",
});
