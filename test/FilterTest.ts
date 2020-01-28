import * as assert from "assert";
import * as sinon from "sinon";
import { MapSchema, Reflection, DataChange } from "../src";

import { StateWithFilter, Unit, Inventory } from "./Schema";

describe("@filter", () => {
    it("should filter property inside root", () => {
        const state = new StateWithFilter();
        state.filteredNumber = 10;

        const client1 = { sessionId: "one" };
        const client2 = { sessionId: "two" };

        const decoded1 = (new StateWithFilter()).decode(state.encodeFiltered(client1));
        const decoded2 = (new StateWithFilter()).decode(state.encodeFiltered(client2));

        assert.equal(decoded1.filteredNumber, 10);
        assert.equal(decoded2.filteredNumber, undefined);
    });

    it("should filter property outside of root", () => {
        const state = new StateWithFilter();
        state.units = new MapSchema<Unit>();
        state.units.one = new Unit();
        state.units.one.inventory = new Inventory();
        state.units.one.inventory.items = 10;

        state.units.two = new Unit();
        state.units.two.inventory = new Inventory();
        state.units.two.inventory.items = 20;

        const client1 = { sessionId: "one" };
        const client2 = { sessionId: "two" };
        const client3 = { sessionId: "three" };

        const decoded1 = (new StateWithFilter()).decode(state.encodeFiltered(client1));
        state.encodeAllFiltered(client3);
        const decoded2 = (new StateWithFilter()).decode(state.encodeFiltered(client2));

        assert.equal(decoded1.units.one.inventory.items, 10);
        assert.equal(decoded1.units.two.inventory, undefined);

        assert.equal(decoded2.units.one.inventory, undefined);
        assert.equal(decoded2.units.two.inventory.items, 20);
    });

    xit("should filter map entries by distance", () => {
        const state = new StateWithFilter();
        state.unitsWithDistanceFilter = new MapSchema<Unit>();

        const createUnit = (key: string, x: number, y: number) => {
            const unit = new Unit();
            unit.x = x;
            unit.y = y;
            state.unitsWithDistanceFilter[key] = unit;
        };

        createUnit("one", 0, 0);
        createUnit("two", 10, 0);
        createUnit("three", 15, 0);
        createUnit("four", 20, 0);
        createUnit("five", 50, 0);

        const client1 = { sessionId: "one" };
        const client2 = { sessionId: "two" };
        const client3 = { sessionId: "three" };
        const client4 = { sessionId: "four" };
        const client5 = { sessionId: "five" };

        const decoded1 = (new StateWithFilter()).decode(state.encodeFiltered(client1));
        const decoded2 = (new StateWithFilter()).decode(state.encodeFiltered(client2));
        const decoded3 = (new StateWithFilter()).decode(state.encodeFiltered(client3));
        const decoded4 = (new StateWithFilter()).decode(state.encodeFiltered(client4));
        const decoded5 = (new StateWithFilter()).decode(state.encodeFiltered(client5));

        assert.deepEqual(Object.keys(decoded1.unitsWithDistanceFilter), ['one', 'two']);
        assert.deepEqual(Object.keys(decoded2.unitsWithDistanceFilter), ['one', 'two', 'three', 'four']);
        assert.deepEqual(Object.keys(decoded3.unitsWithDistanceFilter), ['two', 'three', 'four']);
        assert.deepEqual(Object.keys(decoded4.unitsWithDistanceFilter), ['two', 'three', 'four']);
        assert.deepEqual(Object.keys(decoded5.unitsWithDistanceFilter), ['five']);
    });

    xit("should trigger onAdd when filter starts to match", () => {
        const state = new StateWithFilter();
        state.unitsWithDistanceFilter = new MapSchema<Unit>();

        const client5 = { sessionId: "five" };

        // FIRST DECODE
        const decoded5 = (new StateWithFilter()).decode(state.encodeFiltered(client5));
        assert.equal(JSON.stringify(decoded5), '{"units":{},"unitsWithDistanceFilter":{}}');

        const createUnit = (key: string, x: number, y: number) => {
            const unit = new Unit();
            unit.x = x;
            unit.y = y;
            state.unitsWithDistanceFilter[key] = unit;
        };

        createUnit("one", 0, 0);
        createUnit("two", 10, 0);
        createUnit("three", 15, 0);
        createUnit("four", 20, 0);
        createUnit("five", 50, 0);

        // SECOND DECODE
        decoded5.decode(state.encodeFiltered(client5));
        assert.equal(JSON.stringify(decoded5), '{"units":{},"unitsWithDistanceFilter":{"five":{"x":50,"y":0}}}');

        assert.deepEqual(Object.keys(decoded5.unitsWithDistanceFilter), ['five']);

        // SECOND DECODE
        state.unitsWithDistanceFilter.five.x = 30;
        decoded5.unitsWithDistanceFilter.onAdd = function(item, key) {}
        let onAddSpy = sinon.spy(decoded5.unitsWithDistanceFilter, 'onAdd');

        decoded5.decode(state.encodeFiltered(client5));
        assert.equal(JSON.stringify(decoded5), '{"units":{},"unitsWithDistanceFilter":{"five":{"x":30,"y":0},"four":{"x":20,"y":0}}}');

        assert.deepEqual(Object.keys(decoded5.unitsWithDistanceFilter), ['five', 'four']);

        // THIRD DECODE
        state.unitsWithDistanceFilter.five.x = 17;
        decoded5.decode(state.encodeFiltered(client5));
        assert.equal(JSON.stringify(decoded5), '{"units":{},"unitsWithDistanceFilter":{"five":{"x":17,"y":0},"four":{"x":20,"y":0},"two":{"x":10,"y":0},"three":{"x":15,"y":0}}}');

        assert.deepEqual(Object.keys(decoded5.unitsWithDistanceFilter), ['five', 'four', 'two', 'three']);
        sinon.assert.calledThrice(onAddSpy);
    });

    xit("should trigger onRemove when filter by distance doesn't match anymore", () => {
        const state = new StateWithFilter();
        state.unitsWithDistanceFilter = new MapSchema<Unit>();

        const createUnit = (key: string, x: number, y: number) => {
            const unit = new Unit();
            unit.x = x;
            unit.y = y;
            state.unitsWithDistanceFilter[key] = unit;
        };

        createUnit("one", 0, 0);
        createUnit("two", 10, 0);
        createUnit("three", 20, 0);

        const client2 = { sessionId: "two" };

        const decoded2 = new StateWithFilter();
        decoded2.unitsWithDistanceFilter.onAdd = function(unit, key) {
            console.log("onAdd =>", key);
        }
        decoded2.unitsWithDistanceFilter.onRemove = function(unit, key) {
            console.log("onRemove =>", key);
        }
        const onAddSpy = sinon.spy(decoded2.unitsWithDistanceFilter, 'onAdd');
        const onRemoveSpy = sinon.spy(decoded2.unitsWithDistanceFilter, 'onRemove');

        decoded2.decode(state.encodeFiltered(client2));

        state.unitsWithDistanceFilter['three'].x = 21;
        decoded2.decode(state.encodeFiltered(client2));

        sinon.assert.calledThrice(onAddSpy);
        // assert.deepEqual(Object.keys(decoded2.unitsWithDistanceFilter), ['one', 'two', 'three', 'four']);
    });

    it("should not trigger `onChange` if field haven't changed", () => {
        const state = new StateWithFilter();
        state.filteredNumber = 10;

        const client1 = { sessionId: "one" };

        const decoded1 = new StateWithFilter();
        decoded1.decode(state.encodeFiltered(client1));

        let changes: DataChange[];

        decoded1.onChange = (changelist) => changes = changelist;

        state.unfilteredString = "20";
        decoded1.decode(state.encodeFiltered(client1));

        assert.deepEqual([
            { field: 'unfilteredString', value: '20', previousValue: undefined }
        ], changes);

        state.filteredNumber = 11;
        decoded1.decode(state.encodeFiltered(client1));
        assert.deepEqual([
            { field: 'filteredNumber', value: 11, previousValue: 10 }
        ], changes);
    });
});