"use strict";
exports.__esModule = true;
var MapSchema = /** @class */ (function () {
    function MapSchema(obj) {
        if (obj === void 0) { obj = {}; }
        var _this = this;
        for (var key in obj) {
            this[key] = obj[key];
        }
        Object.defineProperties(this, {
            $changes: { value: undefined, enumerable: false, writable: true },
            onAdd: { value: undefined, enumerable: false, writable: true },
            onRemove: { value: undefined, enumerable: false, writable: true },
            onChange: { value: undefined, enumerable: false, writable: true },
            clone: {
                value: function () {
                    var map = Object.assign(new MapSchema(), _this);
                    map.onAdd = _this.onAdd;
                    map.onRemove = _this.onRemove;
                    map.onChange = _this.onChange;
                    return map;
                }
            },
            triggerAll: {
                value: function () {
                    if (!_this.onAdd) {
                        return;
                    }
                    for (var key in _this) {
                        _this.onAdd(_this[key], key);
                    }
                }
            },
            _indexes: { value: new Map(), enumerable: false, writable: true },
            _updateIndexes: {
                value: function () {
                    var index = 0;
                    var indexes = new Map();
                    for (var key in _this) {
                        indexes.set(key, index++);
                    }
                    _this._indexes = indexes;
                }
            }
        });
    }
    return MapSchema;
}());
exports.MapSchema = MapSchema;
