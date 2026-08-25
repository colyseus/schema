//
// Codegen input for the cross-SDK Predict-layer fixtures — mirrors the
// shapes used by colyseus-0.18 PORTING/generate-predict-fixtures.cts
// (scenario A: ReconState {x, vx} stepped by AccelInput {ax}).
//
import { schema, t } from "../src/index.js";

export const ReconState = schema({
    x: t.number(),
    vx: t.number(),
}, "ReconState");

export const AccelInput = schema({
    ax: t.number(),
}, "AccelInput");

export const PassiveEnt = schema({
    a: t.number(),
    b: t.number(),
    c: t.number(),
    d: t.number(),
    yaw: t.number(),
}, "PassiveEnt");

export const ReckonBall = schema({
    x: t.number(),
    vx: t.number(),
}, "ReckonBall");
