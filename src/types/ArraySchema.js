"use strict";
var __extends = (this && this.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
exports.__esModule = true;
var ArraySchema = /** @class */ (function (_super) {
    __extends(ArraySchema, _super);
    function ArraySchema() {
        var items = [];
        for (var _i = 0; _i < arguments.length; _i++) {
            items[_i] = arguments[_i];
        }
        var _this = _super.apply(this, items) || this;
        Object.setPrototypeOf(_this, Object.create(ArraySchema.prototype));
        Object.defineProperties(_this, {
            $changes: { value: undefined, enumerable: false, writable: true },
            onAdd: { value: undefined, enumerable: false, writable: true },
            onRemove: { value: undefined, enumerable: false, writable: true },
            onChange: { value: undefined, enumerable: false, writable: true },
            triggerAll: {
                value: function () {
                    if (!_this.onAdd) {
                        return;
                    }
                    for (var i = 0; i < _this.length; i++) {
                        _this.onAdd(_this[i], i);
                    }
                }
            },
            clone: {
                value: function () {
                    var arr = new (ArraySchema.bind.apply(ArraySchema, [void 0].concat(_this)))();
                    arr.onAdd = _this.onAdd;
                    arr.onRemove = _this.onRemove;
                    arr.onChange = _this.onChange;
                    return arr;
                }
            }
        });
        return _this;
    }
    Object.defineProperty(ArraySchema, Symbol.species, {
        get: function () { return Array; },
        enumerable: true,
        configurable: true
    });
    return ArraySchema;
}(Array));
exports.ArraySchema = ArraySchema;
