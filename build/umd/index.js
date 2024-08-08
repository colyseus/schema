(function (global, factory) {
    typeof exports === 'object' && typeof module !== 'undefined' ? factory(exports) :
    typeof define === 'function' && define.amd ? define(['exports'], factory) :
    (global = typeof globalThis !== 'undefined' ? globalThis : global || self, factory(global.schema = {}));
})(this, (function (exports) { 'use strict';

    const SWITCH_TO_STRUCTURE = 255; // (decoding collides with DELETE_AND_ADD + fieldIndex = 63)
    const TYPE_ID = 213;
    /**
     * Encoding Schema field operations.
     */
    exports.OPERATION = void 0;
    (function (OPERATION) {
        OPERATION[OPERATION["ADD"] = 128] = "ADD";
        OPERATION[OPERATION["REPLACE"] = 0] = "REPLACE";
        OPERATION[OPERATION["DELETE"] = 64] = "DELETE";
        OPERATION[OPERATION["DELETE_AND_MOVE"] = 96] = "DELETE_AND_MOVE";
        OPERATION[OPERATION["MOVE_AND_ADD"] = 160] = "MOVE_AND_ADD";
        OPERATION[OPERATION["DELETE_AND_ADD"] = 192] = "DELETE_AND_ADD";
        /**
         * Collection operations
         */
        OPERATION[OPERATION["CLEAR"] = 10] = "CLEAR";
        /**
         * ArraySchema operations
         */
        OPERATION[OPERATION["PUSH"] = 11] = "PUSH";
        OPERATION[OPERATION["UNSHIFT"] = 12] = "UNSHIFT";
        OPERATION[OPERATION["REVERSE"] = 15] = "REVERSE";
        OPERATION[OPERATION["MOVE"] = 32] = "MOVE";
        OPERATION[OPERATION["DELETE_BY_REFID"] = 33] = "DELETE_BY_REFID";
        OPERATION[OPERATION["ADD_BY_REFID"] = 129] = "ADD_BY_REFID";
    })(exports.OPERATION || (exports.OPERATION = {}));

    Symbol.metadata ??= Symbol.for("Symbol.metadata");

    const $track = Symbol("$track");
    const $encoder = Symbol("$encoder");
    const $decoder = Symbol("$decoder");
    const $filter = Symbol("$filter");
    const $getByIndex = Symbol("$getByIndex");
    const $deleteByIndex = Symbol("$deleteByIndex");
    /**
     * Used to hold ChangeTree instances whitin the structures
     */
    const $changes = Symbol('$changes');
    /**
     * Used to keep track of the type of the child elements of a collection
     * (MapSchema, ArraySchema, etc.)
     */
    const $childType = Symbol('$childType');
    /**
     * Special ChangeTree property to identify new instances
     * (Once they're encoded, they're not new anymore)
     */
    const $isNew = Symbol("$isNew");
    /**
     * Optional "discard" method for custom types (ArraySchema)
     * (Discards changes for next serialization)
     */
    const $onEncodeEnd = Symbol('$onEncodeEnd');
    /**
     * When decoding, this method is called after the instance is fully decoded
     */
    const $onDecodeEnd = Symbol("$onDecodeEnd");

    const registeredTypes = {};
    const identifiers = new Map();
    function registerType(identifier, definition) {
        identifiers.set(definition.constructor, identifier);
        registeredTypes[identifier] = definition;
    }
    function getType(identifier) {
        return registeredTypes[identifier];
    }

    const Metadata = {
        addField(metadata, index, field, type, descriptor) {
            if (index > 64) {
                throw new Error(`Can't define field '${field}'.\nSchema instances may only have up to 64 fields.`);
            }
            metadata[field] = Object.assign(metadata[field] || {}, // avoid overwriting previous field metadata (@owned / @deprecated)
            {
                type: (Array.isArray(type))
                    ? { array: type[0] }
                    : type,
                index,
                descriptor,
            });
            // map -1 as last field index
            Object.defineProperty(metadata, -1, {
                value: index,
                enumerable: false,
                configurable: true
            });
            // map index => field name (non enumerable)
            Object.defineProperty(metadata, index, {
                value: field,
                enumerable: false,
                configurable: true,
            });
        },
        setTag(metadata, fieldName, tag) {
            // add 'tag' to the field
            const field = metadata[fieldName];
            field.tag = tag;
            if (!metadata[-2]) {
                // -2: all field indexes with "view" tag
                Object.defineProperty(metadata, -2, {
                    value: [],
                    enumerable: false,
                    configurable: true
                });
                // -3: field indexes by "view" tag
                Object.defineProperty(metadata, -3, {
                    value: {},
                    enumerable: false,
                    configurable: true
                });
            }
            metadata[-2].push(field.index);
            if (!metadata[-3][tag]) {
                metadata[-3][tag] = [];
            }
            metadata[-3][tag].push(field.index);
        },
        setFields(target, fields) {
            const metadata = (target.prototype.constructor[Symbol.metadata] ??= {});
            // target[$track] = function (changeTree, index: number, operation: OPERATION = OPERATION.ADD) {
            //     changeTree.change(index, operation, encodeSchemaOperation);
            // };
            // target[$encoder] = encodeSchemaOperation;
            // target[$decoder] = decodeSchemaOperation;
            // if (!target.prototype.toJSON) { target.prototype.toJSON = Schema.prototype.toJSON; }
            let index = 0;
            for (const field in fields) {
                const type = fields[field];
                // FIXME: this code is duplicated from @type() annotation
                const complexTypeKlass = (Array.isArray(type))
                    ? getType("array")
                    : (typeof (Object.keys(type)[0]) === "string") && getType(Object.keys(type)[0]);
                Metadata.addField(metadata, index, field, type, getPropertyDescriptor(`_${field}`, index, type, complexTypeKlass, metadata, field));
                index++;
            }
        },
        isDeprecated(metadata, field) {
            return metadata[field].deprecated === true;
        },
        init(klass) {
            //
            // Used only to initialize an empty Schema (Encoder#constructor)
            // TODO: remove/refactor this...
            //
            const metadata = {};
            klass.constructor[Symbol.metadata] = metadata;
            Object.defineProperty(metadata, -1, {
                value: 0,
                enumerable: false,
                configurable: true,
            });
        },
        initialize(constructor, parentMetadata) {
            let metadata = constructor[Symbol.metadata] ?? Object.create(null);
            // make sure inherited classes have their own metadata object.
            if (constructor[Symbol.metadata] === parentMetadata) {
                metadata = Object.create(null);
                if (parentMetadata) {
                    // assign parent metadata to current
                    Object.assign(metadata, parentMetadata);
                    for (let i = 0; i <= parentMetadata[-1]; i++) {
                        Object.defineProperty(metadata, i, {
                            value: parentMetadata[i],
                            enumerable: false,
                            configurable: true,
                        });
                    }
                    Object.defineProperty(metadata, -1, {
                        value: parentMetadata[-1],
                        enumerable: false,
                        configurable: true,
                        writable: true,
                    });
                }
            }
            constructor[Symbol.metadata] = metadata;
            return metadata;
        },
        isValidInstance(klass) {
            return (klass.constructor[Symbol.metadata] &&
                Object.prototype.hasOwnProperty.call(klass.constructor[Symbol.metadata], -1));
        },
        getFields(klass) {
            const metadata = klass[Symbol.metadata];
            const fields = {};
            for (let i = 0; i <= metadata[-1]; i++) {
                fields[metadata[i]] = metadata[metadata[i]].type;
            }
            return fields;
        }
    };

    var _a$5;
    class Root {
        constructor() {
            this.nextUniqueId = 0;
            this.refCount = new WeakMap();
            // all changes
            this.allChanges = new Map();
            this.allFilteredChanges = new Map();
            // pending changes to be encoded
            this.changes = new Map();
            this.filteredChanges = new Map();
        }
        getNextUniqueId() {
            return this.nextUniqueId++;
        }
        add(changeTree) {
            const refCount = this.refCount.get(changeTree) || 0;
            this.refCount.set(changeTree, refCount + 1);
        }
        remove(changeTree) {
            const refCount = this.refCount.get(changeTree);
            if (refCount <= 1) {
                this.allChanges.delete(changeTree);
                this.changes.delete(changeTree);
                if (changeTree.isFiltered || changeTree.isPartiallyFiltered) {
                    this.allFilteredChanges.delete(changeTree);
                    this.filteredChanges.delete(changeTree);
                }
                this.refCount.delete(changeTree);
            }
            else {
                this.refCount.set(changeTree, refCount - 1);
            }
            changeTree.forEachChild((child, _) => this.remove(child));
        }
        clear() {
            this.changes.clear();
        }
    }
    class ChangeTree {
        static { _a$5 = $isNew; }
        ;
        constructor(ref) {
            this.indexes = {}; // TODO: remove this, only used by MapSchema/SetSchema/CollectionSchema (`encodeKeyValueOperation`)
            this.currentOperationIndex = 0;
            this.allChanges = new Map();
            this.allFilteredChanges = new Map();
            this.changes = new Map();
            this.filteredChanges = new Map();
            this[_a$5] = true;
            this.ref = ref;
        }
        setRoot(root) {
            this.root = root;
            this.root.add(this);
            //
            // At Schema initialization, the "root" structure might not be available
            // yet, as it only does once the "Encoder" has been set up.
            //
            // So the "parent" may be already set without a "root".
            //
            this.checkIsFiltered(this.parent, this.parentIndex);
            // unique refId for the ChangeTree.
            this.ensureRefId();
            if (!this.isFiltered) {
                this.root.changes.set(this, this.changes);
            }
            if (this.isFiltered || this.isPartiallyFiltered) {
                this.root.allFilteredChanges.set(this, this.allFilteredChanges);
                this.root.filteredChanges.set(this, this.filteredChanges);
                // } else {
                //     this.root.allChanges.set(this, this.allChanges);
            }
            if (!this.isFiltered) {
                this.root.allChanges.set(this, this.allChanges);
            }
            this.forEachChild((changeTree, _) => {
                changeTree.setRoot(root);
            });
            // this.allChanges.forEach((_, index) => {
            //     const childRef = this.ref[$getByIndex](index);
            //     if (childRef && childRef[$changes]) {
            //         childRef[$changes].setRoot(root);
            //     }
            // });
        }
        setParent(parent, root, parentIndex) {
            this.parent = parent;
            this.parentIndex = parentIndex;
            // avoid setting parents with empty `root`
            if (!root) {
                return;
            }
            root.add(this);
            // skip if parent is already set
            if (root === this.root) {
                this.forEachChild((changeTree, atIndex) => {
                    changeTree.setParent(this.ref, root, atIndex);
                });
                return;
            }
            this.root = root;
            this.checkIsFiltered(parent, parentIndex);
            if (!this.isFiltered) {
                this.root.changes.set(this, this.changes);
                this.root.allChanges.set(this, this.allChanges);
            }
            if (this.isFiltered || this.isPartiallyFiltered) {
                this.root.filteredChanges.set(this, this.filteredChanges);
                this.root.allFilteredChanges.set(this, this.filteredChanges);
            }
            this.ensureRefId();
            this.forEachChild((changeTree, atIndex) => {
                changeTree.setParent(this.ref, root, atIndex);
            });
        }
        forEachChild(callback) {
            //
            // assign same parent on child structures
            //
            if (Metadata.isValidInstance(this.ref)) {
                const metadata = this.ref['constructor'][Symbol.metadata];
                // FIXME: need to iterate over parent metadata instead.
                for (const field in metadata) {
                    const value = this.ref[field];
                    if (value && value[$changes]) {
                        callback(value[$changes], metadata[field].index);
                    }
                }
            }
            else if (typeof (this.ref) === "object") {
                // MapSchema / ArraySchema, etc.
                this.ref.forEach((value, key) => {
                    if (Metadata.isValidInstance(value)) {
                        callback(value[$changes], this.ref[$changes].indexes[key]);
                    }
                });
            }
        }
        operation(op) {
            this.changes.set(--this.currentOperationIndex, op);
            this.root?.changes.set(this, this.changes);
        }
        change(index, operation = exports.OPERATION.ADD) {
            const metadata = this.ref['constructor'][Symbol.metadata];
            const isFiltered = this.isFiltered || (metadata && metadata[metadata[index]].tag !== undefined);
            const changeSet = (isFiltered)
                ? this.filteredChanges
                : this.changes;
            const previousOperation = changeSet.get(index);
            if (!previousOperation || previousOperation === exports.OPERATION.DELETE) {
                const op = (!previousOperation)
                    ? operation
                    : (previousOperation === exports.OPERATION.DELETE)
                        ? exports.OPERATION.DELETE_AND_ADD
                        : operation;
                changeSet.set(index, op);
            }
            //
            // TODO: are DELETE operations being encoded as ADD here ??
            //
            if (isFiltered) {
                this.allFilteredChanges.set(index, exports.OPERATION.ADD);
                this.root?.filteredChanges.set(this, this.filteredChanges);
            }
            else {
                this.allChanges.set(index, exports.OPERATION.ADD);
                this.root?.changes.set(this, this.changes);
            }
        }
        shiftChangeIndexes(shiftIndex) {
            //
            // Used only during:
            //
            // - ArraySchema#unshift()
            //
            const changeSet = (this.isFiltered)
                ? this.filteredChanges
                : this.changes;
            const changeSetEntries = Array.from(changeSet.entries());
            changeSet.clear();
            // Re-insert each entry with the shifted index
            for (const [index, op] of changeSetEntries) {
                changeSet.set(index + shiftIndex, op);
            }
        }
        shiftAllChangeIndexes(shiftIndex, startIndex = 0) {
            //
            // Used only during:
            //
            // - ArraySchema#splice()
            //
            if (this.isFiltered || this.isPartiallyFiltered) {
                this._shiftAllChangeIndexes(shiftIndex, startIndex, this.allFilteredChanges);
                this._shiftAllChangeIndexes(shiftIndex, startIndex, this.allChanges);
            }
            else {
                this._shiftAllChangeIndexes(shiftIndex, startIndex, this.allChanges);
            }
        }
        _shiftAllChangeIndexes(shiftIndex, startIndex = 0, allChangeSet) {
            Array.from(allChangeSet.entries()).forEach(([index, op]) => {
                if (index >= startIndex) {
                    allChangeSet.delete(index);
                    allChangeSet.set(index + shiftIndex, op);
                }
            });
        }
        indexedOperation(index, operation, allChangesIndex = index) {
            const metadata = this.ref['constructor'][Symbol.metadata];
            const isFiltered = this.isFiltered || (metadata && metadata[metadata[index]].tag !== undefined);
            if (isFiltered) {
                this.allFilteredChanges.set(allChangesIndex, exports.OPERATION.ADD);
                this.filteredChanges.set(index, operation);
                this.root?.filteredChanges.set(this, this.filteredChanges);
            }
            else {
                this.allChanges.set(allChangesIndex, exports.OPERATION.ADD);
                this.changes.set(index, operation);
                this.root?.changes.set(this, this.changes);
            }
        }
        getType(index) {
            if (Metadata.isValidInstance(this.ref)) {
                const metadata = this.ref['constructor'][Symbol.metadata];
                return metadata[metadata[index]].type;
            }
            else {
                //
                // Get the child type from parent structure.
                // - ["string"] => "string"
                // - { map: "string" } => "string"
                // - { set: "string" } => "string"
                //
                return this.ref[$childType];
            }
        }
        getChange(index) {
            // TODO: optimize this. avoid checking against multiple instances
            return this.changes.get(index) ?? this.filteredChanges.get(index);
        }
        //
        // used during `.encode()`
        //
        getValue(index, isEncodeAll = false) {
            //
            // `isEncodeAll` param is only used by ArraySchema
            //
            return this.ref[$getByIndex](index, isEncodeAll);
        }
        delete(index, operation, allChangesIndex = index) {
            if (index === undefined) {
                try {
                    throw new Error(`@colyseus/schema ${this.ref.constructor.name}: trying to delete non-existing index '${index}'`);
                }
                catch (e) {
                    console.warn(e);
                }
                return;
            }
            const metadata = this.ref['constructor'][Symbol.metadata];
            const isFiltered = this.isFiltered || (metadata && metadata[metadata[index]].tag !== undefined);
            const changeSet = (isFiltered)
                ? this.filteredChanges
                : this.changes;
            const previousValue = this.getValue(index);
            changeSet.set(index, operation ?? exports.OPERATION.DELETE);
            // remove `root` reference
            if (previousValue && previousValue[$changes]) {
                previousValue[$changes].root = undefined;
                //
                // FIXME: this.root is "undefined"
                //
                // This method is being called at decoding time when a DELETE operation is found.
                //
                // - This is due to using the concrete Schema class at decoding time.
                // - "Reflected" structures do not have this problem.
                //
                // (the property descriptors should NOT be used at decoding time. only at encoding time.)
                //
                this.root?.remove(previousValue[$changes]);
            }
            //
            // FIXME: this is looking a bit ugly (and repeated from `.change()`)
            //
            if (isFiltered) {
                this.root?.filteredChanges.set(this, this.filteredChanges);
                this.allFilteredChanges.delete(allChangesIndex);
            }
            else {
                this.root?.changes.set(this, this.changes);
                this.allChanges.delete(allChangesIndex);
            }
        }
        endEncode() {
            this.changes.clear();
            this.ref[$onEncodeEnd]?.();
            // Not a new instance anymore
            delete this[$isNew];
        }
        discard(discardAll = false) {
            //
            // > MapSchema:
            //      Remove cached key to ensure ADD operations is unsed instead of
            //      REPLACE in case same key is used on next patches.
            //
            this.ref[$onEncodeEnd]?.();
            this.changes.clear();
            this.filteredChanges.clear();
            // reset operation index
            this.currentOperationIndex = 0;
            if (discardAll) {
                this.allChanges.clear();
                this.allFilteredChanges.clear();
                // remove children references
                this.forEachChild((changeTree, _) => this.root?.remove(changeTree));
            }
        }
        /**
         * Recursively discard all changes from this, and child structures.
         */
        discardAll() {
            this.changes.forEach((_, fieldIndex) => {
                const value = this.getValue(fieldIndex);
                if (value && value[$changes]) {
                    value[$changes].discardAll();
                }
            });
            this.discard();
        }
        ensureRefId() {
            // skip if refId is already set.
            if (this.refId !== undefined) {
                return;
            }
            this.refId = this.root.getNextUniqueId();
        }
        get changed() {
            return this.changes.size > 0;
        }
        checkIsFiltered(parent, parentIndex) {
            // Detect if current structure has "filters" declared
            this.isPartiallyFiltered = (this.ref['constructor']?.[Symbol.metadata]?.[-2] !== undefined);
            // TODO: support "partially filtered", where the instance is visible, but only a field is not.
            // Detect if parent has "filters" declared
            while (parent && !this.isFiltered) {
                const metadata = parent['constructor'][Symbol.metadata];
                const fieldName = metadata?.[parentIndex];
                const isParentOwned = metadata?.[fieldName]?.tag !== undefined;
                this.isFiltered = isParentOwned || parent[$changes].isFiltered; // metadata?.[-2]
                parent = parent[$changes].parent;
            }
            //
            // TODO: refactor this!
            //
            //      swapping `changes` and `filteredChanges` is required here
            //      because "isFiltered" may not be imedialely available on `change()`
            //
            if (this.isFiltered && this.changes.size > 0) {
                // swap changes reference
                const changes = this.changes;
                this.changes = this.filteredChanges;
                this.filteredChanges = changes;
                // swap "all changes" reference
                const allFilteredChanges = this.allFilteredChanges;
                this.allFilteredChanges = this.allChanges;
                this.allChanges = allFilteredChanges;
            }
        }
    }

    /**
     * Copyright (c) 2018 Endel Dreyer
     * Copyright (c) 2014 Ion Drive Software Ltd.
     *
     * Permission is hereby granted, free of charge, to any person obtaining a copy
     * of this software and associated documentation files (the "Software"), to deal
     * in the Software without restriction, including without limitation the rights
     * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
     * copies of the Software, and to permit persons to whom the Software is
     * furnished to do so, subject to the following conditions:
     *
     * The above copyright notice and this permission notice shall be included in all
     * copies or substantial portions of the Software.
     *
     * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
     * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
     * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
     * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
     * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
     * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
     * SOFTWARE
     */
    /**
     * msgpack implementation highly based on notepack.io
     * https://github.com/darrachequesne/notepack
     */
    let textEncoder;
    // @ts-ignore
    try {
        textEncoder = new TextEncoder();
    }
    catch (e) { }
    const hasBufferByteLength = (typeof Buffer !== 'undefined' && Buffer.byteLength);
    const utf8Length = (hasBufferByteLength)
        ? Buffer.byteLength // node
        : function (str, _) {
            var c = 0, length = 0;
            for (var i = 0, l = str.length; i < l; i++) {
                c = str.charCodeAt(i);
                if (c < 0x80) {
                    length += 1;
                }
                else if (c < 0x800) {
                    length += 2;
                }
                else if (c < 0xd800 || c >= 0xe000) {
                    length += 3;
                }
                else {
                    i++;
                    length += 4;
                }
            }
            return length;
        };
    function utf8Write(view, str, it) {
        var c = 0;
        for (var i = 0, l = str.length; i < l; i++) {
            c = str.charCodeAt(i);
            if (c < 0x80) {
                view[it.offset++] = c;
            }
            else if (c < 0x800) {
                view[it.offset++] = 0xc0 | (c >> 6);
                view[it.offset++] = 0x80 | (c & 0x3f);
            }
            else if (c < 0xd800 || c >= 0xe000) {
                view[it.offset++] = 0xe0 | (c >> 12);
                view[it.offset++] = 0x80 | (c >> 6 & 0x3f);
                view[it.offset++] = 0x80 | (c & 0x3f);
            }
            else {
                i++;
                c = 0x10000 + (((c & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
                view[it.offset++] = 0xf0 | (c >> 18);
                view[it.offset++] = 0x80 | (c >> 12 & 0x3f);
                view[it.offset++] = 0x80 | (c >> 6 & 0x3f);
                view[it.offset++] = 0x80 | (c & 0x3f);
            }
        }
    }
    function int8$1(bytes, value, it) {
        bytes[it.offset++] = value & 255;
    }
    function uint8$1(bytes, value, it) {
        bytes[it.offset++] = value & 255;
    }
    function int16$1(bytes, value, it) {
        bytes[it.offset++] = value & 255;
        bytes[it.offset++] = (value >> 8) & 255;
    }
    function uint16$1(bytes, value, it) {
        bytes[it.offset++] = value & 255;
        bytes[it.offset++] = (value >> 8) & 255;
    }
    function int32$1(bytes, value, it) {
        bytes[it.offset++] = value & 255;
        bytes[it.offset++] = (value >> 8) & 255;
        bytes[it.offset++] = (value >> 16) & 255;
        bytes[it.offset++] = (value >> 24) & 255;
    }
    function uint32$1(bytes, value, it) {
        const b4 = value >> 24;
        const b3 = value >> 16;
        const b2 = value >> 8;
        const b1 = value;
        bytes[it.offset++] = b1 & 255;
        bytes[it.offset++] = b2 & 255;
        bytes[it.offset++] = b3 & 255;
        bytes[it.offset++] = b4 & 255;
    }
    function int64$1(bytes, value, it) {
        const high = Math.floor(value / Math.pow(2, 32));
        const low = value >>> 0;
        uint32$1(bytes, low, it);
        uint32$1(bytes, high, it);
    }
    function uint64$1(bytes, value, it) {
        const high = (value / Math.pow(2, 32)) >> 0;
        const low = value >>> 0;
        uint32$1(bytes, low, it);
        uint32$1(bytes, high, it);
    }
    function float32$1(bytes, value, it) {
        writeFloat32(bytes, value, it);
    }
    function float64$1(bytes, value, it) {
        writeFloat64(bytes, value, it);
    }
    const _int32$1 = new Int32Array(2);
    const _float32$1 = new Float32Array(_int32$1.buffer);
    const _float64$1 = new Float64Array(_int32$1.buffer);
    function writeFloat32(bytes, value, it) {
        _float32$1[0] = value;
        int32$1(bytes, _int32$1[0], it);
    }
    function writeFloat64(bytes, value, it) {
        _float64$1[0] = value;
        int32$1(bytes, _int32$1[0 ], it);
        int32$1(bytes, _int32$1[1 ], it);
    }
    function boolean$1(bytes, value, it) {
        bytes[it.offset++] = value ? 1 : 0; // uint8
    }
    function string$1(bytes, value, it) {
        // encode `null` strings as empty.
        if (!value) {
            value = "";
        }
        let length = utf8Length(value, "utf8");
        let size = 0;
        // fixstr
        if (length < 0x20) {
            bytes[it.offset++] = length | 0xa0;
            size = 1;
        }
        // str 8
        else if (length < 0x100) {
            bytes[it.offset++] = 0xd9;
            bytes[it.offset++] = length % 255;
            size = 2;
        }
        // str 16
        else if (length < 0x10000) {
            bytes[it.offset++] = 0xda;
            uint16$1(bytes, length, it);
            size = 3;
        }
        // str 32
        else if (length < 0x100000000) {
            bytes[it.offset++] = 0xdb;
            uint32$1(bytes, length, it);
            size = 5;
        }
        else {
            throw new Error('String too long');
        }
        utf8Write(bytes, value, it);
        return size + length;
    }
    function number$1(bytes, value, it) {
        if (isNaN(value)) {
            return number$1(bytes, 0, it);
        }
        else if (!isFinite(value)) {
            return number$1(bytes, (value > 0) ? Number.MAX_SAFE_INTEGER : -Number.MAX_SAFE_INTEGER, it);
        }
        else if (value !== (value | 0)) {
            bytes[it.offset++] = 0xcb;
            writeFloat64(bytes, value, it);
            return 9;
            // TODO: encode float 32?
            // is it possible to differentiate between float32 / float64 here?
            // // float 32
            // bytes.push(0xca);
            // writeFloat32(bytes, value);
            // return 5;
        }
        if (value >= 0) {
            // positive fixnum
            if (value < 0x80) {
                bytes[it.offset++] = value & 255; // uint8
                return 1;
            }
            // uint 8
            if (value < 0x100) {
                bytes[it.offset++] = 0xcc;
                bytes[it.offset++] = value & 255; // uint8
                return 2;
            }
            // uint 16
            if (value < 0x10000) {
                bytes[it.offset++] = 0xcd;
                uint16$1(bytes, value, it);
                return 3;
            }
            // uint 32
            if (value < 0x100000000) {
                bytes[it.offset++] = 0xce;
                uint32$1(bytes, value, it);
                return 5;
            }
            // uint 64
            bytes[it.offset++] = 0xcf;
            uint64$1(bytes, value, it);
            return 9;
        }
        else {
            // negative fixnum
            if (value >= -0x20) {
                bytes[it.offset++] = 0xe0 | (value + 0x20);
                return 1;
            }
            // int 8
            if (value >= -0x80) {
                bytes[it.offset++] = 0xd0;
                int8$1(bytes, value, it);
                return 2;
            }
            // int 16
            if (value >= -0x8000) {
                bytes[it.offset++] = 0xd1;
                int16$1(bytes, value, it);
                return 3;
            }
            // int 32
            if (value >= -0x80000000) {
                bytes[it.offset++] = 0xd2;
                int32$1(bytes, value, it);
                return 5;
            }
            // int 64
            bytes[it.offset++] = 0xd3;
            int64$1(bytes, value, it);
            return 9;
        }
    }

    var encode = /*#__PURE__*/Object.freeze({
        __proto__: null,
        boolean: boolean$1,
        float32: float32$1,
        float64: float64$1,
        int16: int16$1,
        int32: int32$1,
        int64: int64$1,
        int8: int8$1,
        number: number$1,
        string: string$1,
        uint16: uint16$1,
        uint32: uint32$1,
        uint64: uint64$1,
        uint8: uint8$1,
        utf8Length: utf8Length,
        utf8Write: utf8Write,
        writeFloat32: writeFloat32,
        writeFloat64: writeFloat64
    });

    class EncodeSchemaError extends Error {
    }
    function assertType(value, type, klass, field) {
        let typeofTarget;
        let allowNull = false;
        switch (type) {
            case "number":
            case "int8":
            case "uint8":
            case "int16":
            case "uint16":
            case "int32":
            case "uint32":
            case "int64":
            case "uint64":
            case "float32":
            case "float64":
                typeofTarget = "number";
                if (isNaN(value)) {
                    console.log(`trying to encode "NaN" in ${klass.constructor.name}#${field}`);
                }
                break;
            case "string":
                typeofTarget = "string";
                allowNull = true;
                break;
            case "boolean":
                // boolean is always encoded as true/false based on truthiness
                return;
        }
        if (typeof (value) !== typeofTarget && (!allowNull || (allowNull && value !== null))) {
            let foundValue = `'${JSON.stringify(value)}'${(value && value.constructor && ` (${value.constructor.name})`) || ''}`;
            throw new EncodeSchemaError(`a '${typeofTarget}' was expected, but ${foundValue} was provided in ${klass.constructor.name}#${field}`);
        }
    }
    function assertInstanceType(value, type, klass, field) {
        if (!(value instanceof type)) {
            throw new EncodeSchemaError(`a '${type.name}' was expected, but '${value && value.constructor.name}' was provided in ${klass.constructor.name}#${field}`);
        }
    }

    function encodePrimitiveType(type, bytes, value, klass, field, it) {
        assertType(value, type, klass, field);
        const encodeFunc = encode[type];
        if (encodeFunc) {
            encodeFunc(bytes, value, it);
            // encodeFunc(bytes, value);
        }
        else {
            throw new EncodeSchemaError(`a '${type}' was expected, but ${value} was provided in ${klass.constructor.name}#${field}`);
        }
    }
    function encodeValue(encoder, bytes, ref, type, value, field, operation, it) {
        if (type[Symbol.metadata] !== undefined) {
            // TODO: move this to the `@type()` annotation
            assertInstanceType(value, type, ref, field);
            //
            // Encode refId for this instance.
            // The actual instance is going to be encoded on next `changeTree` iteration.
            //
            number$1(bytes, value[$changes].refId, it);
            // Try to encode inherited TYPE_ID if it's an ADD operation.
            if ((operation & exports.OPERATION.ADD) === exports.OPERATION.ADD) {
                encoder.tryEncodeTypeId(bytes, type, value.constructor, it);
            }
        }
        else if (typeof (type) === "string") {
            //
            // Primitive values
            //
            encodePrimitiveType(type, bytes, value, ref, field, it);
        }
        else {
            //
            // Custom type (MapSchema, ArraySchema, etc)
            //
            const definition = getType(Object.keys(type)[0]);
            //
            // ensure a ArraySchema has been provided
            //
            assertInstanceType(ref[field], definition.constructor, ref, field);
            //
            // Encode refId for this instance.
            // The actual instance is going to be encoded on next `changeTree` iteration.
            //
            number$1(bytes, value[$changes].refId, it);
        }
    }
    /**
     * Used for Schema instances.
     * @private
     */
    const encodeSchemaOperation = function (encoder, bytes, changeTree, index, operation, it) {
        const ref = changeTree.ref;
        const metadata = ref['constructor'][Symbol.metadata];
        const field = metadata[index];
        const type = metadata[field].type;
        const value = ref[field];
        // "compress" field index + operation
        bytes[it.offset++] = (index | operation) & 255;
        // Do not encode value for DELETE operations
        if (operation === exports.OPERATION.DELETE) {
            return;
        }
        // TODO: inline this function call small performance gain
        encodeValue(encoder, bytes, ref, type, value, field, operation, it);
    };
    /**
     * Used for collections (MapSchema, CollectionSchema, SetSchema)
     * @private
     */
    const encodeKeyValueOperation = function (encoder, bytes, changeTree, field, operation, it) {
        const ref = changeTree.ref;
        // encode operation
        bytes[it.offset++] = operation & 255;
        // custom operations
        if (operation === exports.OPERATION.CLEAR) {
            return;
        }
        // encode index
        number$1(bytes, field, it);
        // Do not encode value for DELETE operations
        if (operation === exports.OPERATION.DELETE) {
            return;
        }
        //
        // encode "alias" for dynamic fields (maps)
        //
        if ((operation & exports.OPERATION.ADD) == exports.OPERATION.ADD) { // ADD or DELETE_AND_ADD
            if (typeof (ref['set']) === "function") {
                //
                // MapSchema dynamic key
                //
                const dynamicIndex = changeTree.ref['$indexes'].get(field);
                string$1(bytes, dynamicIndex, it);
            }
        }
        const type = changeTree.getType(field);
        const value = changeTree.getValue(field);
        // try { throw new Error(); } catch (e) {
        //     // only print if not coming from Reflection.ts
        //     if (!e.stack.includes("src/Reflection.ts")) {
        //         console.log("encodeKeyValueOperation -> ", {
        //             ref: changeTree.ref.constructor.name,
        //             field,
        //             operation: OPERATION[operation],
        //             value: value?.toJSON(),
        //             items: ref.toJSON(),
        //         });
        //     }
        // }
        // TODO: inline this function call small performance gain
        encodeValue(encoder, bytes, ref, type, value, field, operation, it);
    };
    /**
     * Used for collections (MapSchema, ArraySchema, etc.)
     * @private
     */
    const encodeArray = function (encoder, bytes, changeTree, field, operation, it, isEncodeAll, hasView) {
        const ref = changeTree.ref;
        const useOperationByRefId = hasView && changeTree.isFiltered && (typeof (changeTree.getType(field)) !== "string");
        let refOrIndex;
        if (useOperationByRefId) {
            refOrIndex = ref['tmpItems'][field][$changes].refId;
            if (operation === exports.OPERATION.DELETE) {
                operation = exports.OPERATION.DELETE_BY_REFID;
            }
            else if (operation === exports.OPERATION.ADD) {
                operation = exports.OPERATION.ADD_BY_REFID;
            }
        }
        else {
            refOrIndex = field;
        }
        // encode operation
        bytes[it.offset++] = operation & 255;
        // custom operations
        if (operation === exports.OPERATION.CLEAR) {
            return;
        }
        // encode index
        number$1(bytes, refOrIndex, it);
        // Do not encode value for DELETE operations
        if (operation === exports.OPERATION.DELETE) {
            return;
        }
        const type = changeTree.getType(field);
        const value = changeTree.getValue(field, isEncodeAll);
        // console.log("encodeArray -> ", {
        //     ref: changeTree.ref.constructor.name,
        //     field,
        //     operation: OPERATION[operation],
        //     value: value?.toJSON(),
        //     items: ref.toJSON(),
        // });
        // TODO: inline this function call small performance gain
        encodeValue(encoder, bytes, ref, type, value, field, operation, it);
    };

    /**
     * Copyright (c) 2018 Endel Dreyer
     * Copyright (c) 2014 Ion Drive Software Ltd.
     *
     * Permission is hereby granted, free of charge, to any person obtaining a copy
     * of this software and associated documentation files (the "Software"), to deal
     * in the Software without restriction, including without limitation the rights
     * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
     * copies of the Software, and to permit persons to whom the Software is
     * furnished to do so, subject to the following conditions:
     *
     * The above copyright notice and this permission notice shall be included in all
     * copies or substantial portions of the Software.
     *
     * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
     * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
     * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
     * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
     * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
     * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
     * SOFTWARE
     */
    function utf8Read(bytes, it, length) {
        var string = '', chr = 0;
        for (var i = it.offset, end = it.offset + length; i < end; i++) {
            var byte = bytes[i];
            if ((byte & 0x80) === 0x00) {
                string += String.fromCharCode(byte);
                continue;
            }
            if ((byte & 0xe0) === 0xc0) {
                string += String.fromCharCode(((byte & 0x1f) << 6) |
                    (bytes[++i] & 0x3f));
                continue;
            }
            if ((byte & 0xf0) === 0xe0) {
                string += String.fromCharCode(((byte & 0x0f) << 12) |
                    ((bytes[++i] & 0x3f) << 6) |
                    ((bytes[++i] & 0x3f) << 0));
                continue;
            }
            if ((byte & 0xf8) === 0xf0) {
                chr = ((byte & 0x07) << 18) |
                    ((bytes[++i] & 0x3f) << 12) |
                    ((bytes[++i] & 0x3f) << 6) |
                    ((bytes[++i] & 0x3f) << 0);
                if (chr >= 0x010000) { // surrogate pair
                    chr -= 0x010000;
                    string += String.fromCharCode((chr >>> 10) + 0xD800, (chr & 0x3FF) + 0xDC00);
                }
                else {
                    string += String.fromCharCode(chr);
                }
                continue;
            }
            console.error('Invalid byte ' + byte.toString(16));
            // (do not throw error to avoid server/client from crashing due to hack attemps)
            // throw new Error('Invalid byte ' + byte.toString(16));
        }
        it.offset += length;
        return string;
    }
    function int8(bytes, it) {
        return uint8(bytes, it) << 24 >> 24;
    }
    function uint8(bytes, it) {
        return bytes[it.offset++];
    }
    function int16(bytes, it) {
        return uint16(bytes, it) << 16 >> 16;
    }
    function uint16(bytes, it) {
        return bytes[it.offset++] | bytes[it.offset++] << 8;
    }
    function int32(bytes, it) {
        return bytes[it.offset++] | bytes[it.offset++] << 8 | bytes[it.offset++] << 16 | bytes[it.offset++] << 24;
    }
    function uint32(bytes, it) {
        return int32(bytes, it) >>> 0;
    }
    function float32(bytes, it) {
        return readFloat32(bytes, it);
    }
    function float64(bytes, it) {
        return readFloat64(bytes, it);
    }
    function int64(bytes, it) {
        const low = uint32(bytes, it);
        const high = int32(bytes, it) * Math.pow(2, 32);
        return high + low;
    }
    function uint64(bytes, it) {
        const low = uint32(bytes, it);
        const high = uint32(bytes, it) * Math.pow(2, 32);
        return high + low;
    }
    const _int32 = new Int32Array(2);
    const _float32 = new Float32Array(_int32.buffer);
    const _float64 = new Float64Array(_int32.buffer);
    function readFloat32(bytes, it) {
        _int32[0] = int32(bytes, it);
        return _float32[0];
    }
    function readFloat64(bytes, it) {
        _int32[0 ] = int32(bytes, it);
        _int32[1 ] = int32(bytes, it);
        return _float64[0];
    }
    function boolean(bytes, it) {
        return uint8(bytes, it) > 0;
    }
    function string(bytes, it) {
        const prefix = bytes[it.offset++];
        let length;
        if (prefix < 0xc0) {
            // fixstr
            length = prefix & 0x1f;
        }
        else if (prefix === 0xd9) {
            length = uint8(bytes, it);
        }
        else if (prefix === 0xda) {
            length = uint16(bytes, it);
        }
        else if (prefix === 0xdb) {
            length = uint32(bytes, it);
        }
        return utf8Read(bytes, it, length);
    }
    function stringCheck(bytes, it) {
        const prefix = bytes[it.offset];
        return (
        // fixstr
        (prefix < 0xc0 && prefix > 0xa0) ||
            // str 8
            prefix === 0xd9 ||
            // str 16
            prefix === 0xda ||
            // str 32
            prefix === 0xdb);
    }
    function number(bytes, it) {
        const prefix = bytes[it.offset++];
        if (prefix < 0x80) {
            // positive fixint
            return prefix;
        }
        else if (prefix === 0xca) {
            // float 32
            return readFloat32(bytes, it);
        }
        else if (prefix === 0xcb) {
            // float 64
            return readFloat64(bytes, it);
        }
        else if (prefix === 0xcc) {
            // uint 8
            return uint8(bytes, it);
        }
        else if (prefix === 0xcd) {
            // uint 16
            return uint16(bytes, it);
        }
        else if (prefix === 0xce) {
            // uint 32
            return uint32(bytes, it);
        }
        else if (prefix === 0xcf) {
            // uint 64
            return uint64(bytes, it);
        }
        else if (prefix === 0xd0) {
            // int 8
            return int8(bytes, it);
        }
        else if (prefix === 0xd1) {
            // int 16
            return int16(bytes, it);
        }
        else if (prefix === 0xd2) {
            // int 32
            return int32(bytes, it);
        }
        else if (prefix === 0xd3) {
            // int 64
            return int64(bytes, it);
        }
        else if (prefix > 0xdf) {
            // negative fixint
            return (0xff - prefix + 1) * -1;
        }
    }
    function numberCheck(bytes, it) {
        const prefix = bytes[it.offset];
        // positive fixint - 0x00 - 0x7f
        // float 32        - 0xca
        // float 64        - 0xcb
        // uint 8          - 0xcc
        // uint 16         - 0xcd
        // uint 32         - 0xce
        // uint 64         - 0xcf
        // int 8           - 0xd0
        // int 16          - 0xd1
        // int 32          - 0xd2
        // int 64          - 0xd3
        return (prefix < 0x80 ||
            (prefix >= 0xca && prefix <= 0xd3));
    }
    function arrayCheck(bytes, it) {
        return bytes[it.offset] < 0xa0;
        // const prefix = bytes[it.offset] ;
        // if (prefix < 0xa0) {
        //   return prefix;
        // // array
        // } else if (prefix === 0xdc) {
        //   it.offset += 2;
        // } else if (0xdd) {
        //   it.offset += 4;
        // }
        // return prefix;
    }
    function switchStructureCheck(bytes, it) {
        return (
        // previous byte should be `SWITCH_TO_STRUCTURE`
        bytes[it.offset - 1] === SWITCH_TO_STRUCTURE &&
            // next byte should be a number
            (bytes[it.offset] < 0x80 || (bytes[it.offset] >= 0xca && bytes[it.offset] <= 0xd3)));
    }

    var decode = /*#__PURE__*/Object.freeze({
        __proto__: null,
        arrayCheck: arrayCheck,
        boolean: boolean,
        float32: float32,
        float64: float64,
        int16: int16,
        int32: int32,
        int64: int64,
        int8: int8,
        number: number,
        numberCheck: numberCheck,
        readFloat32: readFloat32,
        readFloat64: readFloat64,
        string: string,
        stringCheck: stringCheck,
        switchStructureCheck: switchStructureCheck,
        uint16: uint16,
        uint32: uint32,
        uint64: uint64,
        uint8: uint8,
        utf8Read: utf8Read
    });

    const DEFINITION_MISMATCH = -1;
    function decodeValue(decoder, operation, ref, index, type, bytes, it, allChanges) {
        const $root = decoder.root;
        const previousValue = ref[$getByIndex](index);
        let value;
        if ((operation & exports.OPERATION.DELETE) === exports.OPERATION.DELETE) {
            // Flag `refId` for garbage collection.
            const previousRefId = $root.refIds.get(previousValue);
            if (previousRefId !== undefined) {
                $root.removeRef(previousRefId);
            }
            //
            // Delete operations
            //
            if (operation !== exports.OPERATION.DELETE_AND_ADD) {
                ref[$deleteByIndex](index);
                // //
                // // FIXME: is this in the correct place?
                // //      (This is sounding like a workaround just for ArraySchema, see
                // //       "should splice and move" test on ArraySchema.test.ts)
                // //
                // allChanges.push({
                //     ref,
                //     refId: decoder.currentRefId,
                //     op: OPERATION.DELETE,
                //     field: index as unknown as string,
                //     value: undefined,
                //     previousValue,
                // });
            }
            value = null;
        }
        if (operation === exports.OPERATION.DELETE) ;
        else if (Schema.is(type)) {
            const refId = number(bytes, it);
            value = $root.refs.get(refId);
            if (previousValue) {
                const previousRefId = $root.refIds.get(previousValue);
                if (previousRefId &&
                    refId !== previousRefId &&
                    // FIXME: we may need to check for REPLACE operation as well
                    ((operation & exports.OPERATION.DELETE) === exports.OPERATION.DELETE)) {
                    $root.removeRef(previousRefId);
                }
            }
            if ((operation & exports.OPERATION.ADD) === exports.OPERATION.ADD) {
                const childType = decoder.getInstanceType(bytes, it, type);
                if (!value) {
                    value = decoder.createInstanceOfType(childType);
                }
                $root.addRef(refId, value, (value !== previousValue));
            }
        }
        else if (typeof (type) === "string") {
            //
            // primitive value (number, string, boolean, etc)
            //
            value = decode[type](bytes, it);
        }
        else {
            const typeDef = getType(Object.keys(type)[0]);
            const refId = number(bytes, it);
            const valueRef = ($root.refs.has(refId))
                ? previousValue || $root.refs.get(refId)
                : new typeDef.constructor();
            value = valueRef.clone(true);
            value[$childType] = Object.values(type)[0]; // cache childType for ArraySchema and MapSchema
            if (previousValue) {
                let previousRefId = $root.refIds.get(previousValue);
                if (previousRefId !== undefined && refId !== previousRefId) {
                    $root.removeRef(previousRefId);
                    //
                    // enqueue onRemove if structure has been replaced.
                    //
                    const entries = previousValue.entries();
                    let iter;
                    while ((iter = entries.next()) && !iter.done) {
                        const [key, value] = iter.value;
                        // if value is a schema, remove its reference
                        // FIXME: not sure if this is necessary, add more tests to confirm
                        if (typeof (value) === "object") {
                            previousRefId = $root.refIds.get(value);
                            $root.removeRef(previousRefId);
                        }
                        allChanges.push({
                            ref: previousValue,
                            refId: previousRefId,
                            op: exports.OPERATION.DELETE,
                            field: key,
                            value: undefined,
                            previousValue: value,
                        });
                    }
                }
            }
            $root.addRef(refId, value, (valueRef !== previousValue));
        }
        return { value, previousValue };
    }
    const decodeSchemaOperation = function (decoder, bytes, it, ref, allChanges) {
        const first_byte = bytes[it.offset++];
        const metadata = ref['constructor'][Symbol.metadata];
        // "compressed" index + operation
        const operation = (first_byte >> 6) << 6;
        const index = first_byte % (operation || 255);
        // skip early if field is not defined
        const field = metadata[index];
        if (field === undefined) {
            return DEFINITION_MISMATCH;
        }
        const { value, previousValue } = decodeValue(decoder, operation, ref, index, metadata[field].type, bytes, it, allChanges);
        if (value !== null && value !== undefined) {
            ref[field] = value;
        }
        // add change
        if (previousValue !== value) {
            allChanges.push({
                ref,
                refId: decoder.currentRefId,
                op: operation,
                field: field,
                value,
                previousValue,
            });
        }
    };
    const decodeKeyValueOperation = function (decoder, bytes, it, ref, allChanges) {
        // "uncompressed" index + operation (array/map items)
        const operation = bytes[it.offset++];
        if (operation === exports.OPERATION.CLEAR) {
            //
            // When decoding:
            // - enqueue items for DELETE callback.
            // - flag child items for garbage collection.
            //
            decoder.removeChildRefs(ref, allChanges);
            ref.clear();
            return;
        }
        const index = number(bytes, it);
        const type = ref[$childType];
        let dynamicIndex;
        if ((operation & exports.OPERATION.ADD) === exports.OPERATION.ADD) { // ADD or DELETE_AND_ADD
            if (typeof (ref['set']) === "function") {
                dynamicIndex = string(bytes, it); // MapSchema
                ref['setIndex'](index, dynamicIndex);
            }
            else {
                dynamicIndex = index; // ArraySchema
            }
        }
        else {
            // get dynamic index from "ref"
            dynamicIndex = ref['getIndex'](index);
        }
        const { value, previousValue } = decodeValue(decoder, operation, ref, index, type, bytes, it, allChanges);
        if (value !== null && value !== undefined) {
            if (typeof (ref['set']) === "function") {
                // MapSchema
                ref['$items'].set(dynamicIndex, value);
            }
            else if (typeof (ref['$setAt']) === "function") {
                // ArraySchema
                ref['$setAt'](index, value, operation);
            }
            else if (typeof (ref['add']) === "function") {
                // CollectionSchema && SetSchema
                const index = ref.add(value);
                if (typeof (index) === "number") {
                    ref['setIndex'](index, index);
                }
            }
        }
        // add change
        if (previousValue !== value) {
            allChanges.push({
                ref,
                refId: decoder.currentRefId,
                op: operation,
                field: "", // FIXME: remove this
                dynamicIndex,
                value,
                previousValue,
            });
        }
    };
    const decodeArray = function (decoder, bytes, it, ref, allChanges) {
        // "uncompressed" index + operation (array/map items)
        let operation = bytes[it.offset++];
        let index;
        if (operation === exports.OPERATION.CLEAR) {
            //
            // When decoding:
            // - enqueue items for DELETE callback.
            // - flag child items for garbage collection.
            //
            decoder.removeChildRefs(ref, allChanges);
            ref.clear();
            return;
        }
        else if (operation === exports.OPERATION.DELETE_BY_REFID) {
            // TODO: refactor here, try to follow same flow as below
            const refId = number(bytes, it);
            const previousValue = decoder.root.refs.get(refId);
            index = ref.findIndex((value) => value === previousValue);
            ref[$deleteByIndex](index);
            allChanges.push({
                ref,
                refId: decoder.currentRefId,
                op: exports.OPERATION.DELETE,
                field: "", // FIXME: remove this
                dynamicIndex: index,
                value: undefined,
                previousValue,
            });
            return;
        }
        else if (operation === exports.OPERATION.ADD_BY_REFID) {
            // operation = OPERATION.ADD;
            const refId = number(bytes, it);
            const itemByRefId = decoder.root.refs.get(refId);
            // use existing index, or push new value
            index = (itemByRefId)
                ? ref.findIndex((value) => value === itemByRefId)
                : ref.length;
        }
        else {
            index = number(bytes, it);
        }
        const type = ref[$childType];
        let dynamicIndex = index;
        const { value, previousValue } = decodeValue(decoder, operation, ref, index, type, bytes, it, allChanges);
        if (value !== null && value !== undefined &&
            value !== previousValue // avoid setting same value twice (if index === 0 it will result in a "unshift" for ArraySchema)
        ) {
            // ArraySchema
            ref['$setAt'](index, value, operation);
        }
        // add change
        if (previousValue !== value) {
            allChanges.push({
                ref,
                refId: decoder.currentRefId,
                op: operation,
                field: "", // FIXME: remove this
                dynamicIndex,
                value,
                previousValue,
            });
        }
    };

    var _a$4, _b$4;
    const DEFAULT_SORT = (a, b) => {
        const A = a.toString();
        const B = b.toString();
        if (A < B)
            return -1;
        else if (A > B)
            return 1;
        else
            return 0;
    };
    class ArraySchema {
        static { this[_a$4] = encodeArray; }
        static { this[_b$4] = decodeArray; }
        /**
         * Determine if a property must be filtered.
         * - If returns false, the property is NOT going to be encoded.
         * - If returns true, the property is going to be encoded.
         *
         * Encoding with "filters" happens in two steps:
         * - First, the encoder iterates over all "not owned" properties and encodes them.
         * - Then, the encoder iterates over all "owned" properties per instance and encodes them.
         */
        static [(_a$4 = $encoder, _b$4 = $decoder, $filter)](ref, index, view) {
            // console.log("ArraSchema[$filter] VIEW??", !view)
            return (!view ||
                typeof (ref[$childType]) === "string" ||
                // view.items.has(ref[$getByIndex](index)[$changes])
                view.items.has(ref['tmpItems'][index]?.[$changes]));
        }
        static is(type) {
            return (
            // type format: ["string"]
            Array.isArray(type) ||
                // type format: { array: "string" }
                (type['array'] !== undefined));
        }
        constructor(...items) {
            this.items = [];
            this.tmpItems = [];
            this.deletedIndexes = {};
            Object.defineProperty(this, $childType, {
                value: undefined,
                enumerable: false,
                writable: true,
                configurable: true,
            });
            const proxy = new Proxy(this, {
                get: (obj, prop) => {
                    if (typeof (prop) !== "symbol" &&
                        !isNaN(prop) // https://stackoverflow.com/a/175787/892698
                    ) {
                        return this.items[prop];
                    }
                    else {
                        return Reflect.get(obj, prop);
                    }
                },
                set: (obj, key, setValue) => {
                    if (typeof (key) !== "symbol" && !isNaN(key)) {
                        if (setValue === undefined || setValue === null) {
                            obj.$deleteAt(key);
                        }
                        else {
                            if (setValue[$changes]) {
                                if (obj.items[key] !== undefined) {
                                    if (setValue[$changes][$isNew]) {
                                        this[$changes].indexedOperation(Number(key), exports.OPERATION.MOVE_AND_ADD);
                                    }
                                    else {
                                        if ((obj[$changes].getChange(Number(key)) & exports.OPERATION.DELETE) === exports.OPERATION.DELETE) {
                                            this[$changes].indexedOperation(Number(key), exports.OPERATION.DELETE_AND_MOVE);
                                        }
                                        else {
                                            this[$changes].indexedOperation(Number(key), exports.OPERATION.MOVE);
                                        }
                                    }
                                }
                                else if (setValue[$changes][$isNew]) {
                                    this[$changes].indexedOperation(Number(key), exports.OPERATION.ADD);
                                }
                            }
                            else {
                                obj.$changeAt(Number(key), setValue);
                            }
                            this.items[key] = setValue;
                            this.tmpItems[key] = setValue;
                        }
                        return true;
                    }
                    else {
                        return Reflect.set(obj, key, setValue);
                    }
                },
                deleteProperty: (obj, prop) => {
                    if (typeof (prop) === "number") {
                        obj.$deleteAt(prop);
                    }
                    else {
                        delete obj[prop];
                    }
                    return true;
                },
                has: (obj, key) => {
                    if (typeof (key) !== "symbol" && !isNaN(Number(key))) {
                        return Reflect.has(this.items, key);
                    }
                    return Reflect.has(obj, key);
                }
            });
            this[$changes] = new ChangeTree(proxy);
            this.push.apply(this, items);
            return proxy;
        }
        set length(newLength) {
            if (newLength === 0) {
                this.clear();
            }
            else if (newLength < this.items.length) {
                this.splice(newLength, this.length - newLength);
            }
            else {
                console.warn("ArraySchema: can't set .length to a higher value than its length.");
            }
        }
        get length() {
            return this.items.length;
        }
        push(...values) {
            let length = this.tmpItems.length;
            values.forEach((value, i) => {
                // skip null values
                if (value === undefined || value === null) {
                    return;
                }
                const changeTree = this[$changes];
                changeTree.indexedOperation(length, exports.OPERATION.ADD, this.items.length);
                // changeTree.indexes[length] = length;
                this.items.push(value);
                this.tmpItems.push(value);
                //
                // set value's parent after the value is set
                // (to avoid encoding "refId" operations before parent's "ADD" operation)
                //
                value[$changes]?.setParent(this, changeTree.root, length);
                length++;
            });
            return length;
        }
        /**
         * Removes the last element from an array and returns it.
         */
        pop() {
            let index = -1;
            // find last non-undefined index
            for (let i = this.tmpItems.length - 1; i >= 0; i--) {
                // if (this.tmpItems[i] !== undefined) {
                if (this.deletedIndexes[i] !== true) {
                    index = i;
                    break;
                }
            }
            if (index < 0) {
                return undefined;
            }
            this[$changes].delete(index, undefined, this.items.length - 1);
            // this.tmpItems[index] = undefined;
            this.deletedIndexes[index] = true;
            return this.items.pop();
        }
        at(index) {
            // Allow negative indexing from the end
            if (index < 0)
                index += this.length;
            return this.items[index];
        }
        // encoding only
        $changeAt(index, value) {
            if (value === undefined || value === null) {
                console.error("ArraySchema items cannot be null nor undefined; Use `deleteAt(index)` instead.");
                return;
            }
            // skip if the value is the same as cached.
            if (this.items[index] === value) {
                return;
            }
            const changeTree = this[$changes];
            const operation = changeTree.indexes?.[index]?.op ?? exports.OPERATION.ADD;
            changeTree.change(index, operation);
            //
            // set value's parent after the value is set
            // (to avoid encoding "refId" operations before parent's "ADD" operation)
            //
            value[$changes]?.setParent(this, changeTree.root, index);
        }
        // encoding only
        $deleteAt(index, operation) {
            this[$changes].delete(index, operation);
        }
        // decoding only
        $setAt(index, value, operation) {
            if (index === 0 &&
                operation === exports.OPERATION.ADD &&
                this.items[index] !== undefined) {
                // handle decoding unshift
                this.items.unshift(value);
            }
            else if (operation === exports.OPERATION.DELETE_AND_MOVE) {
                this.items.splice(index, 1);
                this.items[index] = value;
            }
            else {
                this.items[index] = value;
            }
        }
        clear() {
            // skip if already clear
            if (this.items.length === 0) {
                return;
            }
            // discard previous operations.
            const changeTree = this[$changes];
            // discard children
            changeTree.forEachChild((changeTree, _) => {
                changeTree.discard(true);
                //
                // TODO: add tests with instance sharing + .clear()
                // FIXME: this.root? is required because it is being called at decoding time.
                //
                // TODO: do not use [$changes] at decoding time.
                //
                changeTree.root?.changes.delete(changeTree);
                changeTree.root?.allChanges.delete(changeTree);
                changeTree.root?.allFilteredChanges.delete(changeTree);
            });
            changeTree.discard(true);
            changeTree.operation(exports.OPERATION.CLEAR);
            this.items.length = 0;
            this.tmpItems.length = 0;
        }
        /**
         * Combines two or more arrays.
         * @param items Additional items to add to the end of array1.
         */
        // @ts-ignore
        concat(...items) {
            return new ArraySchema(...this.items.concat(...items));
        }
        /**
         * Adds all the elements of an array separated by the specified separator string.
         * @param separator A string used to separate one element of an array from the next in the resulting String. If omitted, the array elements are separated with a comma.
         */
        join(separator) {
            return this.items.join(separator);
        }
        /**
         * Reverses the elements in an Array.
         */
        // @ts-ignore
        reverse() {
            this[$changes].operation(exports.OPERATION.REVERSE);
            this.items.reverse();
            this.tmpItems.reverse();
            return this;
        }
        /**
         * Removes the first element from an array and returns it.
         */
        shift() {
            if (this.items.length === 0) {
                return undefined;
            }
            // const index = Number(Object.keys(changeTree.indexes)[0]);
            const index = this.tmpItems.findIndex((item, i) => item === this.items[0]);
            const changeTree = this[$changes];
            changeTree.delete(index);
            changeTree.shiftAllChangeIndexes(-1, index);
            return this.items.shift();
        }
        /**
         * Returns a section of an array.
         * @param start The beginning of the specified portion of the array.
         * @param end The end of the specified portion of the array. This is exclusive of the element at the index 'end'.
         */
        slice(start, end) {
            const sliced = new ArraySchema();
            sliced.push(...this.items.slice(start, end));
            return sliced;
        }
        /**
         * Sorts an array.
         * @param compareFn Function used to determine the order of the elements. It is expected to return
         * a negative value if first argument is less than second argument, zero if they're equal and a positive
         * value otherwise. If omitted, the elements are sorted in ascending, ASCII character order.
         * ```ts
         * [11,2,22,1].sort((a, b) => a - b)
         * ```
         */
        sort(compareFn = DEFAULT_SORT) {
            const changeTree = this[$changes];
            const sortedItems = this.items.sort(compareFn);
            // wouldn't OPERATION.MOVE make more sense here?
            sortedItems.forEach((_, i) => changeTree.change(i, exports.OPERATION.REPLACE));
            this.tmpItems.sort(compareFn);
            return this;
        }
        /**
         * Removes elements from an array and, if necessary, inserts new elements in their place, returning the deleted elements.
         * @param start The zero-based location in the array from which to start removing elements.
         * @param deleteCount The number of elements to remove.
         * @param insertItems Elements to insert into the array in place of the deleted elements.
         */
        splice(start, deleteCount = this.items.length - start, ...insertItems) {
            const changeTree = this[$changes];
            const tmpItemsLength = this.tmpItems.length;
            const insertCount = insertItems.length;
            // build up-to-date list of indexes, excluding removed values.
            const indexes = [];
            for (let i = 0; i < tmpItemsLength; i++) {
                // if (this.tmpItems[i] !== undefined) {
                if (this.deletedIndexes[i] !== true) {
                    indexes.push(i);
                }
            }
            // delete operations at correct index
            for (let i = start; i < start + deleteCount; i++) {
                const index = indexes[i];
                changeTree.delete(index);
                // this.tmpItems[index] = undefined;
                this.deletedIndexes[index] = true;
            }
            // force insert operations
            for (let i = 0; i < insertCount; i++) {
                const addIndex = indexes[start] + i;
                changeTree.indexedOperation(addIndex, exports.OPERATION.ADD);
                // set value's parent/root
                insertItems[i][$changes]?.setParent(this, changeTree.root, addIndex);
            }
            //
            // delete exceeding indexes from "allChanges"
            // (prevent .encodeAll() from encoding non-existing items)
            //
            if (deleteCount > insertCount) {
                changeTree.shiftAllChangeIndexes(-(deleteCount - insertCount), indexes[start + insertCount]);
            }
            return this.items.splice(start, deleteCount, ...insertItems);
        }
        /**
         * Inserts new elements at the start of an array.
         * @param items  Elements to insert at the start of the Array.
         */
        unshift(...items) {
            const changeTree = this[$changes];
            // shift indexes
            changeTree.shiftChangeIndexes(items.length);
            // new index
            if (changeTree.isFiltered) {
                changeTree.filteredChanges.set(this.items.length, exports.OPERATION.ADD);
            }
            else {
                changeTree.allChanges.set(this.items.length, exports.OPERATION.ADD);
            }
            // FIXME: should we use OPERATION.MOVE here instead?
            items.forEach((_, index) => {
                changeTree.change(index, exports.OPERATION.ADD);
            });
            this.tmpItems.unshift(...items);
            return this.items.unshift(...items);
        }
        /**
         * Returns the index of the first occurrence of a value in an array.
         * @param searchElement The value to locate in the array.
         * @param fromIndex The array index at which to begin the search. If fromIndex is omitted, the search starts at index 0.
         */
        indexOf(searchElement, fromIndex) {
            return this.items.indexOf(searchElement, fromIndex);
        }
        /**
         * Returns the index of the last occurrence of a specified value in an array.
         * @param searchElement The value to locate in the array.
         * @param fromIndex The array index at which to begin the search. If fromIndex is omitted, the search starts at the last index in the array.
         */
        lastIndexOf(searchElement, fromIndex = this.length - 1) {
            return this.items.lastIndexOf(searchElement, fromIndex);
        }
        every(callbackfn, thisArg) {
            return this.items.every(callbackfn, thisArg);
        }
        /**
         * Determines whether the specified callback function returns true for any element of an array.
         * @param callbackfn A function that accepts up to three arguments. The some method calls
         * the callbackfn function for each element in the array until the callbackfn returns a value
         * which is coercible to the Boolean value true, or until the end of the array.
         * @param thisArg An object to which the this keyword can refer in the callbackfn function.
         * If thisArg is omitted, undefined is used as the this value.
         */
        some(callbackfn, thisArg) {
            return this.items.some(callbackfn, thisArg);
        }
        /**
         * Performs the specified action for each element in an array.
         * @param callbackfn  A function that accepts up to three arguments. forEach calls the callbackfn function one time for each element in the array.
         * @param thisArg  An object to which the this keyword can refer in the callbackfn function. If thisArg is omitted, undefined is used as the this value.
         */
        forEach(callbackfn, thisArg) {
            return this.items.forEach(callbackfn, thisArg);
        }
        /**
         * Calls a defined callback function on each element of an array, and returns an array that contains the results.
         * @param callbackfn A function that accepts up to three arguments. The map method calls the callbackfn function one time for each element in the array.
         * @param thisArg An object to which the this keyword can refer in the callbackfn function. If thisArg is omitted, undefined is used as the this value.
         */
        map(callbackfn, thisArg) {
            return this.items.map(callbackfn, thisArg);
        }
        filter(callbackfn, thisArg) {
            return this.items.filter(callbackfn, thisArg);
        }
        /**
         * Calls the specified callback function for all the elements in an array. The return value of the callback function is the accumulated result, and is provided as an argument in the next call to the callback function.
         * @param callbackfn A function that accepts up to four arguments. The reduce method calls the callbackfn function one time for each element in the array.
         * @param initialValue If initialValue is specified, it is used as the initial value to start the accumulation. The first call to the callbackfn function provides this value as an argument instead of an array value.
         */
        reduce(callbackfn, initialValue) {
            return this.items.reduce(callbackfn, initialValue);
        }
        /**
         * Calls the specified callback function for all the elements in an array, in descending order. The return value of the callback function is the accumulated result, and is provided as an argument in the next call to the callback function.
         * @param callbackfn A function that accepts up to four arguments. The reduceRight method calls the callbackfn function one time for each element in the array.
         * @param initialValue If initialValue is specified, it is used as the initial value to start the accumulation. The first call to the callbackfn function provides this value as an argument instead of an array value.
         */
        reduceRight(callbackfn, initialValue) {
            return this.items.reduceRight(callbackfn, initialValue);
        }
        /**
         * Returns the value of the first element in the array where predicate is true, and undefined
         * otherwise.
         * @param predicate find calls predicate once for each element of the array, in ascending
         * order, until it finds one where predicate returns true. If such an element is found, find
         * immediately returns that element value. Otherwise, find returns undefined.
         * @param thisArg If provided, it will be used as the this value for each invocation of
         * predicate. If it is not provided, undefined is used instead.
         */
        find(predicate, thisArg) {
            return this.items.find(predicate, thisArg);
        }
        /**
         * Returns the index of the first element in the array where predicate is true, and -1
         * otherwise.
         * @param predicate find calls predicate once for each element of the array, in ascending
         * order, until it finds one where predicate returns true. If such an element is found,
         * findIndex immediately returns that element index. Otherwise, findIndex returns -1.
         * @param thisArg If provided, it will be used as the this value for each invocation of
         * predicate. If it is not provided, undefined is used instead.
         */
        findIndex(predicate, thisArg) {
            return this.items.findIndex(predicate, thisArg);
        }
        /**
         * Returns the this object after filling the section identified by start and end with value
         * @param value value to fill array section with
         * @param start index to start filling the array at. If start is negative, it is treated as
         * length+start where length is the length of the array.
         * @param end index to stop filling the array at. If end is negative, it is treated as
         * length+end.
         */
        fill(value, start, end) {
            //
            // TODO
            //
            throw new Error("ArraySchema#fill() not implemented");
        }
        /**
         * Returns the this object after copying a section of the array identified by start and end
         * to the same array starting at position target
         * @param target If target is negative, it is treated as length+target where length is the
         * length of the array.
         * @param start If start is negative, it is treated as length+start. If end is negative, it
         * is treated as length+end.
         * @param end If not specified, length of the this object is used as its default value.
         */
        copyWithin(target, start, end) {
            //
            // TODO
            //
            throw new Error("ArraySchema#copyWithin() not implemented");
        }
        /**
         * Returns a string representation of an array.
         */
        toString() {
            return this.items.toString();
        }
        /**
         * Returns a string representation of an array. The elements are converted to string using their toLocalString methods.
         */
        toLocaleString() {
            return this.items.toLocaleString();
        }
        ;
        /** Iterator */
        [Symbol.iterator]() {
            return this.items[Symbol.iterator]();
        }
        static get [Symbol.species]() {
            return ArraySchema;
        }
        /**
         * Returns an iterable of key, value pairs for every entry in the array
         */
        entries() { return this.items.entries(); }
        /**
         * Returns an iterable of keys in the array
         */
        keys() { return this.items.keys(); }
        /**
         * Returns an iterable of values in the array
         */
        values() { return this.items.values(); }
        /**
         * Determines whether an array includes a certain element, returning true or false as appropriate.
         * @param searchElement The element to search for.
         * @param fromIndex The position in this array at which to begin searching for searchElement.
         */
        includes(searchElement, fromIndex) {
            return this.items.includes(searchElement, fromIndex);
        }
        //
        // ES2022
        //
        /**
         * Calls a defined callback function on each element of an array. Then, flattens the result into
         * a new array.
         * This is identical to a map followed by flat with depth 1.
         *
         * @param callback A function that accepts up to three arguments. The flatMap method calls the
         * callback function one time for each element in the array.
         * @param thisArg An object to which the this keyword can refer in the callback function. If
         * thisArg is omitted, undefined is used as the this value.
         */
        // @ts-ignore
        flatMap(callback, thisArg) {
            // @ts-ignore
            throw new Error("ArraySchema#flatMap() is not supported.");
        }
        /**
         * Returns a new array with all sub-array elements concatenated into it recursively up to the
         * specified depth.
         *
         * @param depth The maximum recursion depth
         */
        // @ts-ignore
        flat(depth) {
            throw new Error("ArraySchema#flat() is not supported.");
        }
        findLast() {
            // @ts-ignore
            return this.items.findLast.apply(this.items, arguments);
        }
        findLastIndex(...args) {
            // @ts-ignore
            return this.items.findLastIndex.apply(this.items, arguments);
        }
        //
        // ES2023
        //
        with(index, value) {
            const copy = this.items.slice();
            copy[index] = value;
            return new ArraySchema(...copy);
        }
        toReversed() {
            return this.items.slice().reverse();
        }
        toSorted(compareFn) {
            return this.items.slice().sort(compareFn);
        }
        // @ts-ignore
        toSpliced(start, deleteCount, ...items) {
            // @ts-ignore
            return this.items.toSpliced.apply(copy, arguments);
        }
        [($getByIndex)](index, isEncodeAll = false) {
            //
            // TODO: avoid unecessary `this.tmpItems` check during decoding.
            //
            //    ENCODING uses `this.tmpItems` (or `this.items` if `isEncodeAll` is true)
            //    DECODING uses `this.items`
            //
            return (isEncodeAll)
                ? this.items[index]
                : this.deletedIndexes[index]
                    ? this.items[index]
                    : this.tmpItems[index] || this.items[index];
            // return (isEncodeAll)
            //     ? this.items[index]
            //     : this.tmpItems[index] ?? this.items[index];
        }
        [$deleteByIndex](index) {
            this.items[index] = undefined;
        }
        [$onEncodeEnd]() {
            this.tmpItems = this.items.slice();
            this.deletedIndexes = {};
        }
        [$onDecodeEnd]() {
            this.items = this.items.filter((item) => item !== undefined);
        }
        toArray() {
            return this.items.slice(0);
        }
        toJSON() {
            return this.toArray().map((value) => {
                return (typeof (value['toJSON']) === "function")
                    ? value['toJSON']()
                    : value;
            });
        }
        //
        // Decoding utilities
        //
        clone(isDecoding) {
            let cloned;
            if (isDecoding) {
                cloned = new ArraySchema();
                cloned.push(...this.items);
            }
            else {
                cloned = new ArraySchema(...this.map(item => ((item[$changes])
                    ? item.clone()
                    : item)));
            }
            return cloned;
        }
        ;
    }
    registerType("array", { constructor: ArraySchema });

    var _a$3, _b$3;
    class MapSchema {
        static { this[_a$3] = encodeKeyValueOperation; }
        static { this[_b$3] = decodeKeyValueOperation; }
        /**
         * Determine if a property must be filtered.
         * - If returns false, the property is NOT going to be encoded.
         * - If returns true, the property is going to be encoded.
         *
         * Encoding with "filters" happens in two steps:
         * - First, the encoder iterates over all "not owned" properties and encodes them.
         * - Then, the encoder iterates over all "owned" properties per instance and encodes them.
         */
        static [(_a$3 = $encoder, _b$3 = $decoder, $filter)](ref, index, view) {
            if (!view) {
                return true;
            }
            const exists = ref[$getByIndex](index) !== undefined;
            const existsAndChanges = exists && view.items.has(ref[$getByIndex](index)[$changes]);
            return (!view ||
                typeof (ref[$childType]) === "string" ||
                existsAndChanges);
        }
        static is(type) {
            return type['map'] !== undefined;
        }
        constructor(initialValues) {
            this.$items = new Map();
            this.$indexes = new Map();
            this[$changes] = new ChangeTree(this);
            if (initialValues) {
                if (initialValues instanceof Map ||
                    initialValues instanceof MapSchema) {
                    initialValues.forEach((v, k) => this.set(k, v));
                }
                else {
                    for (const k in initialValues) {
                        this.set(k, initialValues[k]);
                    }
                }
            }
            Object.defineProperty(this, $childType, {
                value: undefined,
                enumerable: false,
                writable: true,
                configurable: true,
            });
        }
        /** Iterator */
        [Symbol.iterator]() { return this.$items[Symbol.iterator](); }
        get [Symbol.toStringTag]() { return this.$items[Symbol.toStringTag]; }
        static get [Symbol.species]() { return MapSchema; }
        set(key, value) {
            if (value === undefined || value === null) {
                throw new Error(`MapSchema#set('${key}', ${value}): trying to set ${value} value on '${key}'.`);
            }
            // Force "key" as string
            // See: https://github.com/colyseus/colyseus/issues/561#issuecomment-1646733468
            key = key.toString();
            const changeTree = this[$changes];
            // get "index" for this value.
            const isReplace = typeof (changeTree.indexes[key]) !== "undefined";
            const index = (isReplace)
                ? changeTree.indexes[key]
                : changeTree.indexes[-1] ?? 0;
            let operation = (isReplace)
                ? exports.OPERATION.REPLACE
                : exports.OPERATION.ADD;
            const isRef = (value[$changes]) !== undefined;
            //
            // (encoding)
            // set a unique id to relate directly with this key/value.
            //
            if (!isReplace) {
                this.$indexes.set(index, key);
                changeTree.indexes[key] = index;
                changeTree.indexes[-1] = index + 1;
            }
            else if (!isRef &&
                this.$items.get(key) === value) {
                // if value is the same, avoid re-encoding it.
                return;
            }
            else if (isRef && // if is schema, force ADD operation if value differ from previous one.
                this.$items.get(key) !== value) {
                operation = exports.OPERATION.ADD;
            }
            this.$items.set(key, value);
            changeTree.change(index, operation);
            //
            // set value's parent after the value is set
            // (to avoid encoding "refId" operations before parent's "ADD" operation)
            //
            if (isRef) {
                value[$changes].setParent(this, changeTree.root, index);
            }
            return this;
        }
        get(key) {
            return this.$items.get(key);
        }
        delete(key) {
            const index = this[$changes].indexes[key];
            this[$changes].delete(index);
            return this.$items.delete(key);
        }
        clear() {
            const changeTree = this[$changes];
            // discard previous operations.
            changeTree.discard(true);
            changeTree.indexes = {};
            // clear previous indexes
            this.$indexes.clear();
            // clear items
            this.$items.clear();
            changeTree.operation(exports.OPERATION.CLEAR);
        }
        has(key) {
            return this.$items.has(key);
        }
        forEach(callbackfn) {
            this.$items.forEach(callbackfn);
        }
        entries() {
            return this.$items.entries();
        }
        keys() {
            return this.$items.keys();
        }
        values() {
            return this.$items.values();
        }
        get size() {
            return this.$items.size;
        }
        setIndex(index, key) {
            this.$indexes.set(index, key);
        }
        getIndex(index) {
            return this.$indexes.get(index);
        }
        [$getByIndex](index) {
            return this.$items.get(this.$indexes.get(index));
        }
        [$deleteByIndex](index) {
            const key = this.$indexes.get(index);
            this.$items.delete(key);
            this.$indexes.delete(index);
        }
        [$onEncodeEnd]() {
            const changeTree = this[$changes];
            const changes = changeTree.changes.entries();
            for (const [fieldIndex, operation] of changes) {
                if (operation === exports.OPERATION.DELETE) {
                    const index = this[$getByIndex](fieldIndex);
                    delete changeTree.indexes[index];
                }
            }
        }
        toJSON() {
            const map = {};
            this.forEach((value, key) => {
                map[key] = (typeof (value['toJSON']) === "function")
                    ? value['toJSON']()
                    : value;
            });
            return map;
        }
        //
        // Decoding utilities
        //
        // @ts-ignore
        clone(isDecoding) {
            let cloned;
            if (isDecoding) {
                // client-side
                cloned = Object.assign(new MapSchema(), this);
            }
            else {
                // server-side
                cloned = new MapSchema();
                this.forEach((value, key) => {
                    if (value[$changes]) {
                        cloned.set(key, value['clone']());
                    }
                    else {
                        cloned.set(key, value);
                    }
                });
            }
            return cloned;
        }
    }
    registerType("map", { constructor: MapSchema });

    const DEFAULT_VIEW_TAG = -1;
    class TypeContext {
        /**
         * For inheritance support
         * Keeps track of which classes extends which. (parent -> children)
         */
        static { this.inheritedTypes = new Map(); }
        static register(target) {
            const parent = Object.getPrototypeOf(target);
            if (parent !== Schema) {
                let inherits = TypeContext.inheritedTypes.get(parent);
                if (!inherits) {
                    inherits = new Set();
                    TypeContext.inheritedTypes.set(parent, inherits);
                }
                inherits.add(target);
            }
        }
        constructor(rootClass) {
            this.types = {};
            this.schemas = new Map();
            this.hasFilters = false;
            if (rootClass) {
                this.discoverTypes(rootClass);
            }
        }
        has(schema) {
            return this.schemas.has(schema);
        }
        get(typeid) {
            return this.types[typeid];
        }
        add(schema, typeid = this.schemas.size) {
            // skip if already registered
            if (this.schemas.has(schema)) {
                return false;
            }
            this.types[typeid] = schema;
            this.schemas.set(schema, typeid);
            return true;
        }
        getTypeId(klass) {
            return this.schemas.get(klass);
        }
        discoverTypes(klass) {
            if (!this.add(klass)) {
                return;
            }
            // add classes inherited from this base class
            TypeContext.inheritedTypes.get(klass)?.forEach((child) => {
                this.discoverTypes(child);
            });
            // skip if no fields are defined for this class.
            if (klass[Symbol.metadata] === undefined) {
                klass[Symbol.metadata] = {};
            }
            // const metadata = Metadata.getFor(klass);
            const metadata = klass[Symbol.metadata];
            // if any schema/field has filters, mark "context" as having filters.
            if (metadata[-2]) {
                this.hasFilters = true;
            }
            for (const field in metadata) {
                const fieldType = metadata[field].type;
                if (typeof (fieldType) === "string") {
                    continue;
                }
                if (Array.isArray(fieldType)) {
                    const type = fieldType[0];
                    if (type === "string") {
                        continue;
                    }
                    this.discoverTypes(type);
                }
                else if (typeof (fieldType) === "function") {
                    this.discoverTypes(fieldType);
                }
                else {
                    const type = Object.values(fieldType)[0];
                    // skip primitive types
                    if (typeof (type) === "string") {
                        continue;
                    }
                    this.discoverTypes(type);
                }
            }
        }
    }
    /**
     * [See documentation](https://docs.colyseus.io/state/schema/)
     *
     * Annotate a Schema property to be serializeable.
     * \@type()'d fields are automatically flagged as "dirty" for the next patch.
     *
     * @example Standard usage, with automatic change tracking.
     * ```
     * \@type("string") propertyName: string;
     * ```
     *
     * @example You can provide the "manual" option if you'd like to manually control your patches via .setDirty().
     * ```
     * \@type("string", { manual: true })
     * ```
     */
    // export function type(type: DefinitionType, options?: TypeOptions) {
    //     return function ({ get, set }, context: ClassAccessorDecoratorContext): ClassAccessorDecoratorResult<Schema, any> {
    //         if (context.kind !== "accessor") {
    //             throw new Error("@type() is only supported for class accessor properties");
    //         }
    //         const field = context.name.toString();
    //         //
    //         // detect index for this field, considering inheritance
    //         //
    //         const parent = Object.getPrototypeOf(context.metadata);
    //         let fieldIndex: number = context.metadata[-1] // current structure already has fields defined
    //             ?? (parent && parent[-1]) // parent structure has fields defined
    //             ?? -1; // no fields defined
    //         fieldIndex++;
    //         if (
    //             !parent && // the parent already initializes the `$changes` property
    //             !Metadata.hasFields(context.metadata)
    //         ) {
    //             context.addInitializer(function (this: Ref) {
    //                 Object.defineProperty(this, $changes, {
    //                     value: new ChangeTree(this),
    //                     enumerable: false,
    //                     writable: true
    //                 });
    //             });
    //         }
    //         Metadata.addField(context.metadata, fieldIndex, field, type);
    //         const isArray = ArraySchema.is(type);
    //         const isMap = !isArray && MapSchema.is(type);
    //         // if (options && options.manual) {
    //         //     // do not declare getter/setter descriptor
    //         //     definition.descriptors[field] = {
    //         //         enumerable: true,
    //         //         configurable: true,
    //         //         writable: true,
    //         //     };
    //         //     return;
    //         // }
    //         return {
    //             init(value) {
    //                 // TODO: may need to convert ArraySchema/MapSchema here
    //                 // do not flag change if value is undefined.
    //                 if (value !== undefined) {
    //                     this[$changes].change(fieldIndex);
    //                     // automaticallty transform Array into ArraySchema
    //                     if (isArray) {
    //                         if (!(value instanceof ArraySchema)) {
    //                             value = new ArraySchema(...value);
    //                         }
    //                         value[$childType] = Object.values(type)[0];
    //                     }
    //                     // automaticallty transform Map into MapSchema
    //                     if (isMap) {
    //                         if (!(value instanceof MapSchema)) {
    //                             value = new MapSchema(value);
    //                         }
    //                         value[$childType] = Object.values(type)[0];
    //                     }
    //                     // try to turn provided structure into a Proxy
    //                     if (value['$proxy'] === undefined) {
    //                         if (isMap) {
    //                             value = getMapProxy(value);
    //                         }
    //                     }
    //                 }
    //                 return value;
    //             },
    //             get() {
    //                 return get.call(this);
    //             },
    //             set(value: any) {
    //                 /**
    //                  * Create Proxy for array or map items
    //                  */
    //                 // skip if value is the same as cached.
    //                 if (value === get.call(this)) {
    //                     return;
    //                 }
    //                 if (
    //                     value !== undefined &&
    //                     value !== null
    //                 ) {
    //                     // automaticallty transform Array into ArraySchema
    //                     if (isArray) {
    //                         if (!(value instanceof ArraySchema)) {
    //                             value = new ArraySchema(...value);
    //                         }
    //                         value[$childType] = Object.values(type)[0];
    //                     }
    //                     // automaticallty transform Map into MapSchema
    //                     if (isMap) {
    //                         if (!(value instanceof MapSchema)) {
    //                             value = new MapSchema(value);
    //                         }
    //                         value[$childType] = Object.values(type)[0];
    //                     }
    //                     // try to turn provided structure into a Proxy
    //                     if (value['$proxy'] === undefined) {
    //                         if (isMap) {
    //                             value = getMapProxy(value);
    //                         }
    //                     }
    //                     // flag the change for encoding.
    //                     this[$changes].change(fieldIndex);
    //                     //
    //                     // call setParent() recursively for this and its child
    //                     // structures.
    //                     //
    //                     if (value[$changes]) {
    //                         value[$changes].setParent(
    //                             this,
    //                             this[$changes].root,
    //                             Metadata.getIndex(context.metadata, field),
    //                         );
    //                     }
    //                 } else if (get.call(this)) {
    //                     //
    //                     // Setting a field to `null` or `undefined` will delete it.
    //                     //
    //                     this[$changes].delete(field);
    //                 }
    //                 set.call(this, value);
    //             },
    //         };
    //     }
    // }
    function view(tag = DEFAULT_VIEW_TAG) {
        return function (target, fieldName) {
            const constructor = target.constructor;
            const parentClass = Object.getPrototypeOf(constructor);
            const parentMetadata = parentClass[Symbol.metadata];
            // TODO: use Metadata.initialize()
            const metadata = (constructor[Symbol.metadata] ??= Object.assign({}, constructor[Symbol.metadata], parentMetadata ?? Object.create(null)));
            if (!metadata[fieldName]) {
                //
                // detect index for this field, considering inheritance
                //
                metadata[fieldName] = {
                    type: undefined,
                    index: (metadata[-1] // current structure already has fields defined
                        ?? (parentMetadata && parentMetadata[-1]) // parent structure has fields defined
                        ?? -1) + 1 // no fields defined
                };
            }
            Metadata.setTag(metadata, fieldName, tag);
        };
    }
    function type(type, options) {
        return function (target, field) {
            const constructor = target.constructor;
            if (!type) {
                throw new Error(`${constructor.name}: @type() reference provided for "${field}" is undefined. Make sure you don't have any circular dependencies.`);
            }
            // for inheritance support
            TypeContext.register(constructor);
            const parentClass = Object.getPrototypeOf(constructor);
            const parentMetadata = parentClass && parentClass[Symbol.metadata];
            const metadata = Metadata.initialize(constructor, parentMetadata);
            let fieldIndex;
            /**
             * skip if descriptor already exists for this field (`@deprecated()`)
             */
            if (metadata[field]) {
                if (metadata[field].deprecated) {
                    // do not create accessors for deprecated properties.
                    return;
                }
                else if (metadata[field].descriptor !== undefined) {
                    // trying to define same property multiple times across inheritance.
                    // https://github.com/colyseus/colyseus-unity3d/issues/131#issuecomment-814308572
                    try {
                        throw new Error(`@colyseus/schema: Duplicate '${field}' definition on '${constructor.name}'.\nCheck @type() annotation`);
                    }
                    catch (e) {
                        const definitionAtLine = e.stack.split("\n")[4].trim();
                        throw new Error(`${e.message} ${definitionAtLine}`);
                    }
                }
                else {
                    fieldIndex = metadata[field].index;
                }
            }
            else {
                //
                // detect index for this field, considering inheritance
                //
                fieldIndex = metadata[-1] // current structure already has fields defined
                    ?? (parentMetadata && parentMetadata[-1]) // parent structure has fields defined
                    ?? -1; // no fields defined
                fieldIndex++;
            }
            if (options && options.manual) {
                Metadata.addField(metadata, fieldIndex, field, type, {
                    // do not declare getter/setter descriptor
                    enumerable: true,
                    configurable: true,
                    writable: true,
                });
            }
            else {
                const complexTypeKlass = (Array.isArray(type))
                    ? getType("array")
                    : (typeof (Object.keys(type)[0]) === "string") && getType(Object.keys(type)[0]);
                const childType = (complexTypeKlass)
                    ? Object.values(type)[0]
                    : type;
                Metadata.addField(metadata, fieldIndex, field, type, getPropertyDescriptor(`_${field}`, fieldIndex, childType, complexTypeKlass, metadata, field));
            }
        };
    }
    function getPropertyDescriptor(fieldCached, fieldIndex, type, complexTypeKlass, metadata, field) {
        return {
            get: function () { return this[fieldCached]; },
            set: function (value) {
                const previousValue = this[fieldCached] || undefined;
                // skip if value is the same as cached.
                if (value === previousValue) {
                    return;
                }
                if (value !== undefined &&
                    value !== null) {
                    if (complexTypeKlass) {
                        // automaticallty transform Array into ArraySchema
                        if (complexTypeKlass.constructor === ArraySchema && !(value instanceof ArraySchema)) {
                            value = new ArraySchema(...value);
                        }
                        // automaticallty transform Map into MapSchema
                        if (complexTypeKlass.constructor === MapSchema && !(value instanceof MapSchema)) {
                            value = new MapSchema(value);
                        }
                        value[$childType] = type;
                    }
                    //
                    // Replacing existing "ref", remove it from root.
                    // TODO: if there are other references to this instance, we should not remove it from root.
                    //
                    if (previousValue !== undefined && previousValue[$changes]) {
                        this[$changes].root?.remove(previousValue[$changes]);
                    }
                    // flag the change for encoding.
                    this.constructor[$track](this[$changes], fieldIndex, exports.OPERATION.ADD);
                    //
                    // call setParent() recursively for this and its child
                    // structures.
                    //
                    if (value[$changes]) {
                        value[$changes].setParent(this, this[$changes].root, metadata[field].index);
                    }
                }
                else if (previousValue !== undefined) {
                    //
                    // Setting a field to `null` or `undefined` will delete it.
                    //
                    this[$changes].delete(fieldIndex);
                }
                this[fieldCached] = value;
            },
            enumerable: true,
            configurable: true
        };
    }
    /**
     * `@deprecated()` flag a field as deprecated.
     * The previous `@type()` annotation should remain along with this one.
     */
    function deprecated(throws = true) {
        return function (klass, field) {
            //
            // FIXME: the following block of code is repeated across `@type()`, `@deprecated()` and `@unreliable()` decorators.
            //
            const constructor = klass.constructor;
            const parentClass = Object.getPrototypeOf(constructor);
            const parentMetadata = parentClass[Symbol.metadata];
            const metadata = (constructor[Symbol.metadata] ??= Object.assign({}, constructor[Symbol.metadata], parentMetadata ?? Object.create(null)));
            if (!metadata[field]) {
                //
                // detect index for this field, considering inheritance
                //
                metadata[field] = {
                    type: undefined,
                    index: (metadata[-1] // current structure already has fields defined
                        ?? (parentMetadata && parentMetadata[-1]) // parent structure has fields defined
                        ?? -1) + 1 // no fields defined
                };
            }
            metadata[field].deprecated = true;
            if (throws) {
                metadata[field].descriptor = {
                    get: function () { throw new Error(`${field} is deprecated.`); },
                    set: function (value) { },
                    enumerable: false,
                    configurable: true
                };
            }
            // flag metadata[field] as non-enumerable
            Object.defineProperty(metadata, field, {
                value: metadata[field],
                enumerable: false,
                configurable: true
            });
        };
    }
    function defineTypes(target, fields, options) {
        for (let field in fields) {
            type(fields[field], options)(target.prototype, field);
        }
        return target;
    }

    function getIndent(level) {
        return (new Array(level).fill(0)).map((_, i) => (i === level - 1) ? `└─ ` : `   `).join("");
    }
    function dumpChanges(schema) {
        const $root = schema[$changes].root;
        const dump = {
            ops: {},
            refs: []
        };
        $root.changes.forEach((operations, changeTree) => {
            dump.refs.push(`refId#${changeTree.refId}`);
            operations.forEach((op, index) => {
                const opName = exports.OPERATION[op];
                if (!dump.ops[opName]) {
                    dump.ops[opName] = 0;
                }
                dump.ops[exports.OPERATION[op]]++;
            });
        });
        return dump;
    }
    function getNextPowerOf2(number) {
        // If number is already a power of 2, return it
        if ((number & (number - 1)) === 0) {
            return number;
        }
        // Find the position of the most significant bit
        let msbPosition = 0;
        while (number > 0) {
            number >>= 1;
            msbPosition++;
        }
        // Return the next power of 2
        return 1 << msbPosition;
    }

    var _a$2, _b$2;
    /**
     * Schema encoder / decoder
     */
    class Schema {
        static { this[_a$2] = encodeSchemaOperation; }
        static { this[_b$2] = decodeSchemaOperation; }
        /**
         * Assign the property descriptors required to track changes on this instance.
         * @param instance
         */
        static initialize(instance) {
            Object.defineProperty(instance, $changes, {
                value: new ChangeTree(instance),
                enumerable: false,
                writable: true
            });
            const metadata = instance.constructor[Symbol.metadata];
            // Define property descriptors
            for (const field in metadata) {
                if (metadata[field].descriptor) {
                    // for encoder
                    Object.defineProperty(instance, `_${field}`, {
                        value: undefined,
                        writable: true,
                        enumerable: false,
                        configurable: true,
                    });
                    Object.defineProperty(instance, field, metadata[field].descriptor);
                }
                else {
                    // for decoder
                    Object.defineProperty(instance, field, {
                        value: undefined,
                        writable: true,
                        enumerable: true,
                        configurable: true,
                    });
                }
                // Object.defineProperty(instance, field, {
                //     ...instance.constructor[Symbol.metadata][field].descriptor
                // });
                // if (args[0]?.hasOwnProperty(field)) {
                //     instance[field] = args[0][field];
                // }
            }
        }
        static is(type) {
            return typeof (type[Symbol.metadata]) === "object";
            // const metadata = type[Symbol.metadata];
            // return metadata && Object.prototype.hasOwnProperty.call(metadata, -1);
        }
        /**
         * Track property changes
         */
        static [(_a$2 = $encoder, _b$2 = $decoder, $track)](changeTree, index, operation = exports.OPERATION.ADD) {
            changeTree.change(index, operation);
        }
        /**
         * Determine if a property must be filtered.
         * - If returns false, the property is NOT going to be encoded.
         * - If returns true, the property is going to be encoded.
         *
         * Encoding with "filters" happens in two steps:
         * - First, the encoder iterates over all "not owned" properties and encodes them.
         * - Then, the encoder iterates over all "owned" properties per instance and encodes them.
         */
        static [$filter](ref, index, view) {
            const metadata = ref.constructor[Symbol.metadata];
            const tag = metadata[metadata[index]].tag;
            if (view === undefined) {
                // shared pass/encode: encode if doesn't have a tag
                return tag === undefined;
            }
            else if (tag === undefined) {
                // view pass: no tag
                return true;
            }
            else if (tag === DEFAULT_VIEW_TAG) {
                // view pass: default tag
                return view.items.has(ref[$changes]);
            }
            else {
                // view pass: custom tag
                const tags = view.tags?.get(ref[$changes]);
                return tags && tags.has(tag);
            }
        }
        // allow inherited classes to have a constructor
        constructor(...args) {
            Schema.initialize(this);
            //
            // Assign initial values
            //
            if (args[0]) {
                this.assign(args[0]);
            }
        }
        assign(props) {
            Object.assign(this, props);
            return this;
        }
        /**
         * (Server-side): Flag a property to be encoded for the next patch.
         * @param instance Schema instance
         * @param property string representing the property name, or number representing the index of the property.
         * @param operation OPERATION to perform (detected automatically)
         */
        setDirty(property, operation) {
            this[$changes].change(this.constructor[Symbol.metadata][property].index, operation);
        }
        clone() {
            const cloned = new (this.constructor);
            const metadata = this.constructor[Symbol.metadata];
            //
            // TODO: clone all properties, not only annotated ones
            //
            // for (const field in this) {
            for (const field in metadata) {
                if (typeof (this[field]) === "object" &&
                    typeof (this[field]?.clone) === "function") {
                    // deep clone
                    cloned[field] = this[field].clone();
                }
                else {
                    // primitive values
                    cloned[field] = this[field];
                }
            }
            return cloned;
        }
        toJSON() {
            const metadata = this.constructor[Symbol.metadata];
            const obj = {};
            for (const fieldName in metadata) {
                const field = metadata[fieldName];
                if (!field.deprecated && this[fieldName] !== null && typeof (this[fieldName]) !== "undefined") {
                    obj[fieldName] = (typeof (this[fieldName]['toJSON']) === "function")
                        ? this[fieldName]['toJSON']()
                        : this[fieldName];
                }
            }
            return obj;
        }
        discardAllChanges() {
            this[$changes].discardAll();
        }
        [$getByIndex](index) {
            return this[this.constructor[Symbol.metadata][index]];
        }
        [$deleteByIndex](index) {
            this[this.constructor[Symbol.metadata][index]] = undefined;
        }
        static debugRefIds(instance, jsonContents = true, level = 0) {
            const ref = instance;
            const changeTree = ref[$changes];
            const contents = (jsonContents) ? ` - ${JSON.stringify(ref.toJSON())}` : "";
            let output = "";
            output += `${getIndent(level)}${ref.constructor.name} (${ref[$changes].refId})${contents}\n`;
            changeTree.forEachChild((childChangeTree) => output += this.debugRefIds(childChangeTree.ref, jsonContents, level + 1));
            return output;
        }
        /**
         * Return a string representation of the changes on a Schema instance.
         * The list of changes is cleared after each encode.
         *
         * @param instance Schema instance
         * @param isEncodeAll Return "full encode" instead of current change set.
         * @returns
         */
        static debugChanges(instance, isEncodeAll = false) {
            const changeTree = instance[$changes];
            const changeSet = (isEncodeAll) ? changeTree.allChanges : changeTree.changes;
            const changeSetName = (isEncodeAll) ? "allChanges" : "changes";
            let output = `${instance.constructor.name} (${changeTree.refId}) -> .${changeSetName}:\n`;
            function dumpChangeSet(changeSet) {
                Array.from(changeSet)
                    .sort((a, b) => a[0] - b[0])
                    .forEach(([index, operation]) => output += `- [${index}]: ${exports.OPERATION[operation]} (${JSON.stringify(changeTree.getValue(index, isEncodeAll))})\n`);
            }
            dumpChangeSet(changeSet);
            // display filtered changes
            if (!isEncodeAll && changeTree.filteredChanges?.size > 0) {
                output += `${instance.constructor.name} (${changeTree.refId}) -> .filteredChanges:\n`;
                dumpChangeSet(changeTree.filteredChanges);
            }
            // display filtered changes
            if (isEncodeAll && changeTree.allFilteredChanges?.size > 0) {
                output += `${instance.constructor.name} (${changeTree.refId}) -> .allFilteredChanges:\n`;
                dumpChangeSet(changeTree.allFilteredChanges);
            }
            return output;
        }
        static debugChangesDeep(ref) {
            let output = "";
            const rootChangeTree = ref[$changes];
            const changeTrees = new Map();
            let totalInstances = 0;
            let totalOperations = 0;
            for (const [changeTree, changes] of (rootChangeTree.root.changes.entries())) {
                let includeChangeTree = false;
                let parentChangeTrees = [];
                let parentChangeTree = changeTree.parent?.[$changes];
                if (changeTree === rootChangeTree) {
                    includeChangeTree = true;
                }
                else {
                    while (parentChangeTree !== undefined) {
                        parentChangeTrees.push(parentChangeTree);
                        if (parentChangeTree.ref === ref) {
                            includeChangeTree = true;
                            break;
                        }
                        parentChangeTree = parentChangeTree.parent?.[$changes];
                    }
                }
                if (includeChangeTree) {
                    totalInstances += 1;
                    totalOperations += changes.size;
                    changeTrees.set(changeTree, parentChangeTrees.reverse());
                }
            }
            output += "---\n";
            output += `root refId: ${rootChangeTree.refId}\n`;
            output += `Total instances: ${totalInstances}\n`;
            output += `Total changes: ${totalOperations}\n`;
            output += "---\n";
            // based on root.changes, display a tree of changes that has the "ref" instance as parent
            const visitedParents = new WeakSet();
            for (const [changeTree, parentChangeTrees] of changeTrees.entries()) {
                parentChangeTrees.forEach((parentChangeTree, level) => {
                    if (!visitedParents.has(parentChangeTree)) {
                        output += `${getIndent(level)}${parentChangeTree.ref.constructor.name} (refId: ${parentChangeTree.refId})\n`;
                        visitedParents.add(parentChangeTree);
                    }
                });
                const changes = changeTree.changes;
                const level = parentChangeTrees.length;
                const indent = getIndent(level);
                const parentIndex = (level > 0) ? `(${changeTree.parentIndex}) ` : "";
                output += `${indent}${parentIndex}${changeTree.ref.constructor.name} (refId: ${changeTree.refId}) - changes: ${changes.size}\n`;
                for (const [index, operation] of changes) {
                    output += `${getIndent(level + 1)}${exports.OPERATION[operation]}: ${index}\n`;
                }
            }
            return `${output}`;
        }
    }

    var _a$1, _b$1;
    class CollectionSchema {
        static { this[_a$1] = encodeKeyValueOperation; }
        static { this[_b$1] = decodeKeyValueOperation; }
        /**
         * Determine if a property must be filtered.
         * - If returns false, the property is NOT going to be encoded.
         * - If returns true, the property is going to be encoded.
         *
         * Encoding with "filters" happens in two steps:
         * - First, the encoder iterates over all "not owned" properties and encodes them.
         * - Then, the encoder iterates over all "owned" properties per instance and encodes them.
         */
        static [(_a$1 = $encoder, _b$1 = $decoder, $filter)](ref, index, view) {
            return (!view ||
                typeof (ref[$childType]) === "string" ||
                view.items.has(ref[$getByIndex](index)[$changes]));
        }
        static is(type) {
            return type['collection'] !== undefined;
        }
        constructor(initialValues) {
            this.$items = new Map();
            this.$indexes = new Map();
            this.$refId = 0;
            this[$changes] = new ChangeTree(this);
            if (initialValues) {
                initialValues.forEach((v) => this.add(v));
            }
            Object.defineProperty(this, $childType, {
                value: undefined,
                enumerable: false,
                writable: true,
                configurable: true,
            });
        }
        add(value) {
            // set "index" for reference.
            const index = this.$refId++;
            const isRef = (value[$changes]) !== undefined;
            if (isRef) {
                value[$changes].setParent(this, this[$changes].root, index);
            }
            this[$changes].indexes[index] = index;
            this.$indexes.set(index, index);
            this.$items.set(index, value);
            this[$changes].change(index);
            return index;
        }
        at(index) {
            const key = Array.from(this.$items.keys())[index];
            return this.$items.get(key);
        }
        entries() {
            return this.$items.entries();
        }
        delete(item) {
            const entries = this.$items.entries();
            let index;
            let entry;
            while (entry = entries.next()) {
                if (entry.done) {
                    break;
                }
                if (item === entry.value[1]) {
                    index = entry.value[0];
                    break;
                }
            }
            if (index === undefined) {
                return false;
            }
            this[$changes].delete(index);
            this.$indexes.delete(index);
            return this.$items.delete(index);
        }
        clear() {
            const changeTree = this[$changes];
            // discard previous operations.
            changeTree.discard(true);
            changeTree.indexes = {};
            // clear previous indexes
            this.$indexes.clear();
            // clear items
            this.$items.clear();
            changeTree.operation(exports.OPERATION.CLEAR);
        }
        has(value) {
            return Array.from(this.$items.values()).some((v) => v === value);
        }
        forEach(callbackfn) {
            this.$items.forEach((value, key, _) => callbackfn(value, key, this));
        }
        values() {
            return this.$items.values();
        }
        get size() {
            return this.$items.size;
        }
        /** Iterator */
        [Symbol.iterator]() {
            return this.$items.values();
        }
        setIndex(index, key) {
            this.$indexes.set(index, key);
        }
        getIndex(index) {
            return this.$indexes.get(index);
        }
        [$getByIndex](index) {
            return this.$items.get(this.$indexes.get(index));
        }
        [$deleteByIndex](index) {
            const key = this.$indexes.get(index);
            this.$items.delete(key);
            this.$indexes.delete(index);
        }
        toArray() {
            return Array.from(this.$items.values());
        }
        toJSON() {
            const values = [];
            this.forEach((value, key) => {
                values.push((typeof (value['toJSON']) === "function")
                    ? value['toJSON']()
                    : value);
            });
            return values;
        }
        //
        // Decoding utilities
        //
        clone(isDecoding) {
            let cloned;
            if (isDecoding) {
                // client-side
                cloned = Object.assign(new CollectionSchema(), this);
            }
            else {
                // server-side
                cloned = new CollectionSchema();
                this.forEach((value) => {
                    if (value[$changes]) {
                        cloned.add(value['clone']());
                    }
                    else {
                        cloned.add(value);
                    }
                });
            }
            return cloned;
        }
    }
    registerType("collection", { constructor: CollectionSchema, });

    var _a, _b;
    class SetSchema {
        static { this[_a] = encodeKeyValueOperation; }
        static { this[_b] = decodeKeyValueOperation; }
        /**
         * Determine if a property must be filtered.
         * - If returns false, the property is NOT going to be encoded.
         * - If returns true, the property is going to be encoded.
         *
         * Encoding with "filters" happens in two steps:
         * - First, the encoder iterates over all "not owned" properties and encodes them.
         * - Then, the encoder iterates over all "owned" properties per instance and encodes them.
         */
        static [(_a = $encoder, _b = $decoder, $filter)](ref, index, view) {
            return (!view ||
                typeof (ref[$childType]) === "string" ||
                view.items.has(ref[$getByIndex](index)[$changes]));
        }
        static is(type) {
            return type['set'] !== undefined;
        }
        constructor(initialValues) {
            this.$items = new Map();
            this.$indexes = new Map();
            this.$refId = 0;
            this[$changes] = new ChangeTree(this);
            if (initialValues) {
                initialValues.forEach((v) => this.add(v));
            }
            Object.defineProperty(this, $childType, {
                value: undefined,
                enumerable: false,
                writable: true,
                configurable: true,
            });
        }
        add(value) {
            // immediatelly return false if value already added.
            if (this.has(value)) {
                return false;
            }
            // set "index" for reference.
            const index = this.$refId++;
            if ((value[$changes]) !== undefined) {
                value[$changes].setParent(this, this[$changes].root, index);
            }
            const operation = this[$changes].indexes[index]?.op ?? exports.OPERATION.ADD;
            this[$changes].indexes[index] = index;
            this.$indexes.set(index, index);
            this.$items.set(index, value);
            this[$changes].change(index, operation);
            return index;
        }
        entries() {
            return this.$items.entries();
        }
        delete(item) {
            const entries = this.$items.entries();
            let index;
            let entry;
            while (entry = entries.next()) {
                if (entry.done) {
                    break;
                }
                if (item === entry.value[1]) {
                    index = entry.value[0];
                    break;
                }
            }
            if (index === undefined) {
                return false;
            }
            this[$changes].delete(index);
            this.$indexes.delete(index);
            return this.$items.delete(index);
        }
        clear() {
            const changeTree = this[$changes];
            // discard previous operations.
            changeTree.discard(true);
            changeTree.indexes = {};
            // clear previous indexes
            this.$indexes.clear();
            // clear items
            this.$items.clear();
            changeTree.operation(exports.OPERATION.CLEAR);
        }
        has(value) {
            const values = this.$items.values();
            let has = false;
            let entry;
            while (entry = values.next()) {
                if (entry.done) {
                    break;
                }
                if (value === entry.value) {
                    has = true;
                    break;
                }
            }
            return has;
        }
        forEach(callbackfn) {
            this.$items.forEach((value, key, _) => callbackfn(value, key, this));
        }
        values() {
            return this.$items.values();
        }
        get size() {
            return this.$items.size;
        }
        /** Iterator */
        [Symbol.iterator]() {
            return this.$items.values();
        }
        setIndex(index, key) {
            this.$indexes.set(index, key);
        }
        getIndex(index) {
            return this.$indexes.get(index);
        }
        [$getByIndex](index) {
            return this.$items.get(this.$indexes.get(index));
        }
        [$deleteByIndex](index) {
            const key = this.$indexes.get(index);
            this.$items.delete(key);
            this.$indexes.delete(index);
        }
        toArray() {
            return Array.from(this.$items.values());
        }
        toJSON() {
            const values = [];
            this.forEach((value, key) => {
                values.push((typeof (value['toJSON']) === "function")
                    ? value['toJSON']()
                    : value);
            });
            return values;
        }
        //
        // Decoding utilities
        //
        clone(isDecoding) {
            let cloned;
            if (isDecoding) {
                // client-side
                cloned = Object.assign(new SetSchema(), this);
            }
            else {
                // server-side
                cloned = new SetSchema();
                this.forEach((value) => {
                    if (value[$changes]) {
                        cloned.add(value['clone']());
                    }
                    else {
                        cloned.add(value);
                    }
                });
            }
            return cloned;
        }
    }
    registerType("set", { constructor: SetSchema });

    /******************************************************************************
    Copyright (c) Microsoft Corporation.

    Permission to use, copy, modify, and/or distribute this software for any
    purpose with or without fee is hereby granted.

    THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
    REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
    AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
    INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
    LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
    OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
    PERFORMANCE OF THIS SOFTWARE.
    ***************************************************************************** */
    /* global Reflect, Promise, SuppressedError, Symbol */


    function __decorate(decorators, target, key, desc) {
        var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
        if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
        else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
        return c > 3 && r && Object.defineProperty(target, key, r), r;
    }

    typeof SuppressedError === "function" ? SuppressedError : function (error, suppressed, message) {
        var e = new Error(message);
        return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
    };

    class Encoder {
        static { this.BUFFER_SIZE = 8 * 1024; } // 8KB
        constructor(root) {
            this.sharedBuffer = Buffer.allocUnsafeSlow(Encoder.BUFFER_SIZE);
            this.setRoot(root);
            //
            // TODO: cache and restore "Context" based on root schema
            // (to avoid creating a new context for every new room)
            //
            this.context = new TypeContext(root.constructor);
            // console.log(">>>>>>>>>>>>>>>> Encoder types");
            // this.context.schemas.forEach((id, schema) => {
            //     console.log("type:", id, schema.name, Object.keys(schema[Symbol.metadata]));
            // });
        }
        setRoot(state) {
            this.root = new Root();
            this.state = state;
            // Workaround to allow using an empty Schema.
            if (state.constructor[Symbol.metadata] === undefined) {
                Metadata.init(state);
            }
            state[$changes].setRoot(this.root);
        }
        encode(it = { offset: 0 }, view, buffer = this.sharedBuffer, changeTrees = this.root.changes, isEncodeAll = this.root.allChanges === changeTrees) {
            const initialOffset = it.offset; // cache current offset in case we need to resize the buffer
            const hasView = (view !== undefined);
            const rootChangeTree = this.state[$changes];
            const changeTreesIterator = changeTrees.entries();
            for (const [changeTree, changes] of changeTreesIterator) {
                const ref = changeTree.ref;
                const ctor = ref['constructor'];
                const encoder = ctor[$encoder];
                const filter = ctor[$filter];
                // try { throw new Error(); } catch (e) {
                //     // only print if not coming from Reflection.ts
                //     if (!e.stack.includes("src/Reflection.ts")) {
                //         console.log("ChangeTree:", { ref: ref.constructor.name, });
                //     }
                // }
                if (hasView) {
                    if (!view.items.has(changeTree)) {
                        view.invisible.add(changeTree);
                        continue; // skip this change tree
                    }
                    else if (view.invisible.has(changeTree)) {
                        view.invisible.delete(changeTree); // remove from invisible list
                    }
                }
                // skip root `refId` if it's the first change tree
                if (it.offset !== initialOffset || changeTree !== rootChangeTree) {
                    buffer[it.offset++] = SWITCH_TO_STRUCTURE & 255;
                    number$1(buffer, changeTree.refId, it);
                }
                const changesIterator = changes.entries();
                for (const [fieldIndex, operation] of changesIterator) {
                    //
                    // first pass (encodeAll), identify "filtered" operations without encoding them
                    // they will be encoded per client, based on their view.
                    //
                    // TODO: how can we optimize filtering out "encode all" operations?
                    // TODO: avoid checking if no view tags were defined
                    //
                    if (filter && !filter(ref, fieldIndex, view)) {
                        // console.log("SKIP FIELD:", { ref: changeTree.ref.constructor.name, fieldIndex, })
                        // console.log("ADD AS INVISIBLE:", fieldIndex, changeTree.ref.constructor.name)
                        // view?.invisible.add(changeTree);
                        continue;
                    }
                    // try { throw new Error(); } catch (e) {
                    //     // only print if not coming from Reflection.ts
                    //     if (!e.stack.includes("src/Reflection.ts")) {
                    //         console.log("WILL ENCODE", {
                    //             ref: changeTree.ref.constructor.name,
                    //             fieldIndex,
                    //             operation: OPERATION[operation],
                    //         });
                    //     }
                    // }
                    encoder(this, buffer, changeTree, fieldIndex, operation, it, isEncodeAll, hasView);
                }
            }
            if (it.offset > buffer.byteLength) {
                const newSize = getNextPowerOf2(buffer.byteLength * 2);
                console.warn(`@colyseus/schema buffer overflow. Encoded state is higher than default BUFFER_SIZE. Use the following to increase default BUFFER_SIZE:

    import { Encoder } from "@colyseus/schema";
    Encoder.BUFFER_SIZE = ${Math.round(newSize / 1024)} * 1024; // ${Math.round(newSize / 1024)} KB
`);
                //
                // resize buffer and re-encode (TODO: can we avoid re-encoding here?)
                //
                buffer = Buffer.allocUnsafeSlow(newSize);
                // assign resized buffer to local sharedBuffer
                if (buffer === this.sharedBuffer) {
                    this.sharedBuffer = buffer;
                }
                return this.encode({ offset: initialOffset }, view, buffer, changeTrees, isEncodeAll);
            }
            else {
                //
                // only clear changes after making sure buffer resize is not required.
                //
                if (!isEncodeAll && !hasView) {
                    //
                    // FIXME: avoid iterating over change trees twice.
                    //
                    this.onEndEncode(changeTrees);
                }
                return buffer.subarray(0, it.offset);
            }
        }
        encodeAll(it = { offset: 0 }, buffer = this.sharedBuffer) {
            // console.log(`encodeAll(), this.root.allChanges (${this.root.allChanges.size})`);
            // Array.from(this.root.allChanges.entries()).map((item) => {
            //     console.log("->", { ref: item[0].ref.constructor.name, refId: item[0].refId, changes: item[1].size });
            // });
            return this.encode(it, undefined, buffer, this.root.allChanges, true);
        }
        encodeAllView(view, sharedOffset, it, bytes = this.sharedBuffer) {
            const viewOffset = it.offset;
            // console.log(`encodeAllView(), this.root.allFilteredChanges (${this.root.allFilteredChanges.size})`);
            // this.debugAllFilteredChanges();
            // try to encode "filtered" changes
            this.encode(it, view, bytes, this.root.allFilteredChanges, true);
            return Buffer.concat([
                bytes.subarray(0, sharedOffset),
                bytes.subarray(viewOffset, it.offset)
            ]);
        }
        debugAllFilteredChanges() {
            Array.from(this.root.allFilteredChanges.entries()).map((item) => {
                console.log("->", { refId: item[0].refId, changes: item[1].size }, item[0].ref.toJSON());
                if (Array.isArray(item[0].ref.toJSON())) {
                    item[1].forEach((op, key) => {
                        console.log("  ->", { key, op: exports.OPERATION[op] });
                    });
                }
            });
        }
        encodeView(view, sharedOffset, it, bytes = this.sharedBuffer) {
            const viewOffset = it.offset;
            // try to encode "filtered" changes
            this.encode(it, view, bytes, this.root.filteredChanges);
            // encode visibility changes (add/remove for this view)
            const viewChangesIterator = view.changes.entries();
            for (const [changeTree, changes] of viewChangesIterator) {
                if (changes.size === 0) {
                    // FIXME: avoid having empty changes if no changes were made
                    // console.log("changes.size === 0", changeTree.ref.constructor.name);
                    continue;
                }
                const ref = changeTree.ref;
                const ctor = ref['constructor'];
                const encoder = ctor[$encoder];
                bytes[it.offset++] = SWITCH_TO_STRUCTURE & 255;
                number$1(bytes, changeTree.refId, it);
                const changesIterator = changes.entries();
                for (const [fieldIndex, operation] of changesIterator) {
                    // isEncodeAll = false
                    // hasView = true
                    encoder(this, bytes, changeTree, fieldIndex, operation, it, false, true);
                }
            }
            //
            // TODO: only clear view changes after all views are encoded
            // (to allow re-using StateView's for multiple clients)
            //
            // clear "view" changes after encoding
            view.changes.clear();
            return Buffer.concat([
                bytes.subarray(0, sharedOffset),
                bytes.subarray(viewOffset, it.offset)
            ]);
        }
        onEndEncode(changeTrees = this.root.changes) {
            const changeTreesIterator = changeTrees.entries();
            for (const [changeTree, _] of changeTreesIterator) {
                changeTree.endEncode();
            }
        }
        discardChanges() {
            // discard shared changes
            if (this.root.changes.size > 0) {
                this.onEndEncode(this.root.changes);
                this.root.changes.clear();
            }
            // discard filtered changes
            if (this.root.filteredChanges.size > 0) {
                this.onEndEncode(this.root.filteredChanges);
                this.root.filteredChanges.clear();
            }
        }
        tryEncodeTypeId(bytes, baseType, targetType, it) {
            const baseTypeId = this.context.getTypeId(baseType);
            const targetTypeId = this.context.getTypeId(targetType);
            if (baseTypeId !== targetTypeId) {
                bytes[it.offset++] = TYPE_ID & 255;
                number$1(bytes, targetTypeId, it);
            }
        }
    }

    function spliceOne(arr, index) {
        // manually splice an array
        if (index === -1 || index >= arr.length) {
            return false;
        }
        const len = arr.length - 1;
        for (let i = index; i < len; i++) {
            arr[i] = arr[i + 1];
        }
        arr.length = len;
        return true;
    }

    class DecodingWarning extends Error {
        constructor(message) {
            super(message);
            this.name = "DecodingWarning";
        }
    }
    class ReferenceTracker {
        constructor() {
            //
            // Relation of refId => Schema structure
            // For direct access of structures during decoding time.
            //
            this.refs = new Map();
            this.refIds = new WeakMap();
            this.refCounts = {};
            this.deletedRefs = new Set();
            this.callbacks = {};
            this.nextUniqueId = 0;
        }
        getNextUniqueId() {
            return this.nextUniqueId++;
        }
        // for decoding
        addRef(refId, ref, incrementCount = true) {
            this.refs.set(refId, ref);
            this.refIds.set(ref, refId);
            if (incrementCount) {
                this.refCounts[refId] = (this.refCounts[refId] || 0) + 1;
            }
            if (this.deletedRefs.has(refId)) {
                this.deletedRefs.delete(refId);
            }
        }
        // for decoding
        removeRef(refId) {
            const refCount = this.refCounts[refId];
            if (refCount === undefined) {
                try {
                    throw new DecodingWarning("trying to remove refId that doesn't exist");
                }
                catch (e) {
                    console.warn(e);
                }
                return;
            }
            if (refCount === 0) {
                try {
                    const ref = this.refs.get(refId);
                    throw new DecodingWarning(`trying to remove refId '${refId}' with 0 refCount (${ref.constructor.name}: ${JSON.stringify(ref)})`);
                }
                catch (e) {
                    console.warn(e);
                }
                return;
            }
            if ((this.refCounts[refId] = refCount - 1) <= 0) {
                this.deletedRefs.add(refId);
            }
        }
        clearRefs() {
            this.refs.clear();
            this.deletedRefs.clear();
            this.refCounts = {};
        }
        // for decoding
        garbageCollectDeletedRefs() {
            this.deletedRefs.forEach((refId) => {
                //
                // Skip active references.
                //
                if (this.refCounts[refId] > 0) {
                    return;
                }
                const ref = this.refs.get(refId);
                //
                // Ensure child schema instances have their references removed as well.
                //
                if (Metadata.isValidInstance(ref)) {
                    const metadata = ref['constructor'][Symbol.metadata];
                    for (const field in metadata) {
                        const childRefId = typeof (ref[field]) === "object" && this.refIds.get(ref[field]);
                        if (childRefId) {
                            this.removeRef(childRefId);
                        }
                    }
                }
                else {
                    if (typeof (Object.values(ref[$childType])[0]) === "function") {
                        Array.from(ref.values())
                            .forEach((child) => this.removeRef(this.refIds.get(child)));
                    }
                }
                this.refs.delete(refId); // remove ref
                delete this.refCounts[refId]; // remove ref count
                delete this.callbacks[refId]; // remove callbacks
            });
            // clear deleted refs.
            this.deletedRefs.clear();
        }
        addCallback(refId, fieldOrOperation, callback) {
            if (refId === undefined) {
                const name = (typeof (fieldOrOperation) === "number")
                    ? exports.OPERATION[fieldOrOperation]
                    : fieldOrOperation;
                throw new Error(`Can't addCallback on '${name}' (refId is undefined)`);
            }
            if (!this.callbacks[refId]) {
                this.callbacks[refId] = {};
            }
            if (!this.callbacks[refId][fieldOrOperation]) {
                this.callbacks[refId][fieldOrOperation] = [];
            }
            this.callbacks[refId][fieldOrOperation].push(callback);
            return () => this.removeCallback(refId, fieldOrOperation, callback);
        }
        removeCallback(refId, field, callback) {
            const index = this.callbacks?.[refId]?.[field]?.indexOf(callback);
            if (index !== -1) {
                spliceOne(this.callbacks[refId][field], index);
            }
        }
    }

    class Decoder {
        constructor(root, context) {
            this.currentRefId = 0;
            this.setRoot(root);
            this.context = context || new TypeContext(root.constructor);
            // console.log(">>>>>>>>>>>>>>>> Decoder types");
            // this.context.schemas.forEach((id, schema) => {
            //     console.log("type:", id, schema.name, Object.keys(schema[Symbol.metadata]));
            // });
        }
        setRoot(root) {
            this.state = root;
            this.root = new ReferenceTracker();
            this.root.addRef(0, root);
        }
        decode(bytes, it = { offset: 0 }, ref = this.state) {
            const allChanges = [];
            const $root = this.root;
            const totalBytes = bytes.byteLength;
            let decoder = ref['constructor'][$decoder];
            this.currentRefId = 0;
            while (it.offset < totalBytes) {
                //
                // Peek ahead, check if it's a switch to a different structure
                //
                if (bytes[it.offset] == SWITCH_TO_STRUCTURE) {
                    it.offset++;
                    this.currentRefId = number(bytes, it);
                    const nextRef = $root.refs.get(this.currentRefId);
                    //
                    // Trying to access a reference that haven't been decoded yet.
                    //
                    if (!nextRef) {
                        throw new Error(`"refId" not found: ${this.currentRefId}`);
                    }
                    ref[$onDecodeEnd]?.();
                    ref = nextRef;
                    decoder = ref['constructor'][$decoder];
                    continue;
                }
                const result = decoder(this, bytes, it, ref, allChanges);
                if (result === DEFINITION_MISMATCH) {
                    console.warn("@colyseus/schema: definition mismatch");
                    //
                    // keep skipping next bytes until reaches a known structure
                    // by local decoder.
                    //
                    const nextIterator = { offset: it.offset };
                    while (it.offset < totalBytes) {
                        if (switchStructureCheck(bytes, it)) {
                            nextIterator.offset = it.offset + 1;
                            if ($root.refs.has(number(bytes, nextIterator))) {
                                break;
                            }
                        }
                        it.offset++;
                    }
                    continue;
                }
            }
            // FIXME: DRY with SWITCH_TO_STRUCTURE block.
            ref[$onDecodeEnd]?.();
            // trigger changes
            this.triggerChanges?.(allChanges);
            // drop references of unused schemas
            $root.garbageCollectDeletedRefs();
            return allChanges;
        }
        getInstanceType(bytes, it, defaultType) {
            let type;
            if (bytes[it.offset] === TYPE_ID) {
                it.offset++;
                const type_id = number(bytes, it);
                type = this.context.get(type_id);
            }
            return type || defaultType;
        }
        createInstanceOfType(type) {
            // let instance: Schema = new (type as any)();
            // // assign root on $changes
            // instance[$changes].root = this.root[$changes].root;
            // return instance;
            return new type();
        }
        removeChildRefs(ref, allChanges) {
            const changeTree = ref[$changes];
            const needRemoveRef = typeof (ref[$childType]) !== "string";
            const refId = changeTree.refId;
            ref.forEach((value, key) => {
                allChanges.push({
                    ref: value,
                    refId,
                    op: exports.OPERATION.DELETE,
                    field: key,
                    value: undefined,
                    previousValue: value
                });
                if (needRemoveRef) {
                    this.root.removeRef(this.root.refIds.get(value));
                }
            });
        }
    }

    /**
     * Reflection
     */
    class ReflectionField extends Schema {
    }
    __decorate([
        type("string")
    ], ReflectionField.prototype, "name", void 0);
    __decorate([
        type("string")
    ], ReflectionField.prototype, "type", void 0);
    __decorate([
        type("number")
    ], ReflectionField.prototype, "referencedType", void 0);
    class ReflectionType extends Schema {
        constructor() {
            super(...arguments);
            this.fields = new ArraySchema();
        }
    }
    __decorate([
        type("number")
    ], ReflectionType.prototype, "id", void 0);
    __decorate([
        type("number")
    ], ReflectionType.prototype, "extendsId", void 0);
    __decorate([
        type([ReflectionField])
    ], ReflectionType.prototype, "fields", void 0);
    class Reflection extends Schema {
        constructor() {
            super(...arguments);
            this.types = new ArraySchema();
        }
        static encode(instance, context, it = { offset: 0 }) {
            if (!context) {
                context = new TypeContext(instance.constructor);
            }
            const reflection = new Reflection();
            const encoder = new Encoder(reflection);
            const buildType = (currentType, metadata) => {
                for (const fieldName in metadata) {
                    // skip fields from parent classes
                    if (!Object.prototype.hasOwnProperty.call(metadata, fieldName)) {
                        continue;
                    }
                    const field = new ReflectionField();
                    field.name = fieldName;
                    let fieldType;
                    const type = metadata[fieldName].type;
                    if (typeof (type) === "string") {
                        fieldType = type;
                    }
                    else {
                        let childTypeSchema;
                        //
                        // TODO: refactor below.
                        //
                        if (Schema.is(type)) {
                            fieldType = "ref";
                            childTypeSchema = type;
                        }
                        else {
                            fieldType = Object.keys(type)[0];
                            if (typeof (type[fieldType]) === "string") {
                                fieldType += ":" + type[fieldType]; // array:string
                            }
                            else {
                                childTypeSchema = type[fieldType];
                            }
                        }
                        field.referencedType = (childTypeSchema)
                            ? context.getTypeId(childTypeSchema)
                            : -1;
                    }
                    field.type = fieldType;
                    currentType.fields.push(field);
                }
                reflection.types.push(currentType);
            };
            for (let typeid in context.types) {
                const klass = context.types[typeid];
                const type = new ReflectionType();
                type.id = Number(typeid);
                // support inheritance
                const inheritFrom = Object.getPrototypeOf(klass);
                if (inheritFrom !== Schema) {
                    type.extendsId = context.schemas.get(inheritFrom);
                }
                buildType(type, klass[Symbol.metadata]);
            }
            const buf = encoder.encodeAll(it);
            return Buffer.from(buf, 0, it.offset);
        }
        static decode(bytes, it) {
            const reflection = new Reflection();
            const reflectionDecoder = new Decoder(reflection);
            reflectionDecoder.decode(bytes, it);
            const typeContext = new TypeContext();
            // 1st pass, initialize metadata + inheritance
            reflection.types.forEach((reflectionType) => {
                const parentClass = typeContext.get(reflectionType.extendsId) ?? Schema;
                const schema = class _ extends parentClass {
                };
                const parentMetadata = parentClass[Symbol.metadata];
                // register for inheritance support
                TypeContext.register(schema);
                // for inheritance support
                Metadata.initialize(schema, parentMetadata);
                typeContext.add(schema, reflectionType.id);
            }, {});
            // 2nd pass, set fields
            reflection.types.forEach((reflectionType) => {
                const schemaType = typeContext.get(reflectionType.id);
                const metadata = schemaType[Symbol.metadata];
                // FIXME: use metadata[-1] to get field count
                const parentFieldIndex = 0;
                // console.log("--------------------");
                // // console.log("reflectionType", reflectionType.toJSON());
                // console.log("reflectionType.fields", reflectionType.fields.toJSON());
                // console.log("parentFieldIndex", parentFieldIndex);
                //
                // FIXME: set fields using parentKlass as well
                // currently the fields are duplicated on inherited classes
                //
                // // const parentKlass = reflection.types[reflectionType.extendsId];
                // // parentKlass.fields
                reflectionType.fields.forEach((field, i) => {
                    const fieldIndex = parentFieldIndex + i;
                    if (field.referencedType !== undefined) {
                        let fieldType = field.type;
                        let refType = typeContext.get(field.referencedType);
                        // map or array of primitive type (-1)
                        if (!refType) {
                            const typeInfo = field.type.split(":");
                            fieldType = typeInfo[0];
                            refType = typeInfo[1]; // string
                        }
                        if (fieldType === "ref") {
                            Metadata.addField(metadata, fieldIndex, field.name, refType);
                        }
                        else {
                            Metadata.addField(metadata, fieldIndex, field.name, { [fieldType]: refType });
                        }
                    }
                    else {
                        Metadata.addField(metadata, fieldIndex, field.name, field.type);
                    }
                });
            });
            // @ts-ignore
            return new (typeContext.get(0))();
        }
    }
    __decorate([
        type([ReflectionType])
    ], Reflection.prototype, "types", void 0);

    function getDecoderStateCallbacks(decoder) {
        const $root = decoder.root;
        const callbacks = $root.callbacks;
        let isTriggeringOnAdd = false;
        decoder.triggerChanges = function (allChanges) {
            const uniqueRefIds = new Set();
            for (let i = 0, l = allChanges.length; i < l; i++) {
                const change = allChanges[i];
                const refId = change.refId;
                const ref = change.ref;
                const $callbacks = callbacks[refId];
                if (!$callbacks) {
                    continue;
                }
                //
                // trigger onRemove on child structure.
                //
                if ((change.op & exports.OPERATION.DELETE) === exports.OPERATION.DELETE &&
                    change.previousValue instanceof Schema) {
                    const deleteCallbacks = callbacks[$root.refIds.get(change.previousValue)]?.[exports.OPERATION.DELETE];
                    for (let i = deleteCallbacks?.length - 1; i >= 0; i--) {
                        deleteCallbacks[i]();
                    }
                }
                if (ref instanceof Schema) {
                    //
                    // Handle schema instance
                    //
                    if (!uniqueRefIds.has(refId)) {
                        // trigger onChange
                        const replaceCallbacks = $callbacks?.[exports.OPERATION.REPLACE];
                        for (let i = replaceCallbacks?.length - 1; i >= 0; i--) {
                            replaceCallbacks[i]();
                            // try {
                            // } catch (e) {
                            //     console.error(e);
                            // }
                        }
                    }
                    if ($callbacks.hasOwnProperty(change.field)) {
                        const fieldCallbacks = $callbacks[change.field];
                        for (let i = fieldCallbacks?.length - 1; i >= 0; i--) {
                            fieldCallbacks[i](change.value, change.previousValue);
                            // try {
                            // } catch (e) {
                            //     console.error(e);
                            // }
                        }
                    }
                }
                else {
                    //
                    // Handle collection of items
                    //
                    if ((change.op & exports.OPERATION.DELETE) === exports.OPERATION.DELETE) {
                        //
                        // FIXME: `previousValue` should always be available.
                        //
                        if (change.previousValue !== undefined) {
                            // triger onRemove
                            const deleteCallbacks = $callbacks[exports.OPERATION.DELETE];
                            for (let i = deleteCallbacks?.length - 1; i >= 0; i--) {
                                deleteCallbacks[i](change.previousValue, change.dynamicIndex ?? change.field);
                            }
                        }
                        // Handle DELETE_AND_ADD operations
                        // FIXME: should we set "isTriggeringOnAdd" here?
                        if ((change.op & exports.OPERATION.ADD) === exports.OPERATION.ADD) {
                            const addCallbacks = $callbacks[exports.OPERATION.ADD];
                            for (let i = addCallbacks?.length - 1; i >= 0; i--) {
                                addCallbacks[i](change.value, change.dynamicIndex ?? change.field);
                            }
                        }
                    }
                    else if ((change.op & exports.OPERATION.ADD) === exports.OPERATION.ADD && change.previousValue === undefined) {
                        // triger onAdd
                        isTriggeringOnAdd = true;
                        const addCallbacks = $callbacks[exports.OPERATION.ADD];
                        for (let i = addCallbacks?.length - 1; i >= 0; i--) {
                            addCallbacks[i](change.value, change.dynamicIndex ?? change.field);
                        }
                        isTriggeringOnAdd = false;
                    }
                    // trigger onChange
                    if (change.value !== change.previousValue) {
                        const replaceCallbacks = $callbacks[exports.OPERATION.REPLACE];
                        for (let i = replaceCallbacks?.length - 1; i >= 0; i--) {
                            replaceCallbacks[i](change.value, change.dynamicIndex ?? change.field);
                        }
                    }
                }
                uniqueRefIds.add(refId);
            }
        };
        function getProxy(metadataOrType, context) {
            let metadata = context.instance?.constructor[Symbol.metadata] || metadataOrType;
            let isCollection = ((context.instance && typeof (context.instance['forEach']) === "function") ||
                (metadataOrType && typeof (metadataOrType[Symbol.metadata]) === "undefined"));
            if (metadata && !isCollection) {
                const onAdd = function (ref, prop, callback, immediate) {
                    // immediate trigger
                    if (immediate &&
                        context.instance[prop] !== undefined &&
                        !isTriggeringOnAdd // FIXME: This is a workaround (https://github.com/colyseus/schema/issues/147)
                    ) {
                        callback(context.instance[prop], undefined);
                    }
                    return $root.addCallback($root.refIds.get(ref), prop, callback);
                };
                /**
                 * Schema instances
                 */
                return new Proxy({
                    listen: function listen(prop, callback, immediate = true) {
                        if (context.instance) {
                            return onAdd(context.instance, prop, callback, immediate);
                        }
                        else {
                            // collection instance not received yet
                            context.onInstanceAvailable((ref, existing) => onAdd(ref, prop, callback, immediate && existing));
                        }
                    },
                    onChange: function onChange(callback) {
                        return $root.addCallback($root.refIds.get(context.instance), exports.OPERATION.REPLACE, callback);
                    },
                    bindTo: function bindTo(targetObject, properties) {
                        //
                        // TODO: refactor this implementation. There is room for improvement here.
                        //
                        if (!properties) {
                            properties = Object.keys(metadata);
                        }
                        return $root.addCallback($root.refIds.get(context.instance), exports.OPERATION.REPLACE, () => {
                            properties.forEach((prop) => targetObject[prop] = context.instance[prop]);
                        });
                    }
                }, {
                    get(target, prop) {
                        if (metadata[prop]) {
                            const instance = context.instance?.[prop];
                            const onInstanceAvailable = ((callback) => {
                                const unbind = $(context.instance).listen(prop, (value, _) => {
                                    callback(value, false);
                                    // FIXME: by "unbinding" the callback here,
                                    // it will not support when the server
                                    // re-instantiates the instance.
                                    //
                                    unbind?.();
                                }, false);
                                // has existing value
                                if ($root.refIds.get(instance) !== undefined) {
                                    callback(instance, true);
                                }
                            });
                            return getProxy(metadata[prop].type, {
                                instance,
                                parentInstance: context.instance,
                                onInstanceAvailable,
                            });
                        }
                        else {
                            // accessing the function
                            return target[prop];
                        }
                    },
                    has(target, prop) { return metadata[prop] !== undefined; },
                    set(_, _1, _2) { throw new Error("not allowed"); },
                    deleteProperty(_, _1) { throw new Error("not allowed"); },
                });
            }
            else {
                /**
                 * Collection instances
                 */
                const onAdd = function (ref, callback, immediate) {
                    // Trigger callback on existing items
                    if (immediate) {
                        ref.forEach((v, k) => callback(v, k));
                    }
                    return $root.addCallback($root.refIds.get(ref), exports.OPERATION.ADD, callback);
                };
                const onRemove = function (ref, callback) {
                    return $root.addCallback($root.refIds.get(ref), exports.OPERATION.DELETE, callback);
                };
                return new Proxy({
                    onAdd: function (callback, immediate = true) {
                        //
                        // https://github.com/colyseus/schema/issues/147
                        // If parent instance has "onAdd" registered, avoid triggering immediate callback.
                        //
                        // FIXME: "isTriggeringOnAdd" is a workaround. We should find a better way to handle this.
                        //
                        if (context.onInstanceAvailable) {
                            // collection instance not received yet
                            context.onInstanceAvailable((ref, existing) => onAdd(ref, callback, immediate && existing && !isTriggeringOnAdd));
                        }
                        else if (context.instance) {
                            onAdd(context.instance, callback, immediate && !isTriggeringOnAdd);
                        }
                    },
                    onRemove: function (callback) {
                        if (context.onInstanceAvailable) {
                            // collection instance not received yet
                            context.onInstanceAvailable((ref) => onRemove(ref, callback));
                        }
                        else if (context.instance) {
                            onRemove(context.instance, callback);
                        }
                    },
                }, {
                    get(target, prop) {
                        if (!target[prop]) {
                            throw new Error(`Can't access '${prop}' through callback proxy. access the instance directly.`);
                        }
                        return target[prop];
                    },
                    has(target, prop) { return target[prop] !== undefined; },
                    set(_, _1, _2) { throw new Error("not allowed"); },
                    deleteProperty(_, _1) { throw new Error("not allowed"); },
                });
            }
        }
        function $(instance) {
            return getProxy(undefined, { instance });
        }
        return $;
    }

    function getRawChangesCallback(decoder, callback) {
        decoder.triggerChanges = callback;
    }

    class StateView {
        constructor() {
            /**
             * List of ChangeTree's that are visible to this view
             */
            this.items = new WeakSet();
            /**
             * List of ChangeTree's that are invisible to this view
             */
            this.invisible = new WeakSet();
            /**
             * Manual "ADD" operations for changes per ChangeTree, specific to this view.
             * (This is used to force encoding a property, even if it was not changed)
             */
            this.changes = new Map();
        }
        // TODO: allow to set multiple tags at once
        add(obj, tag = DEFAULT_VIEW_TAG) {
            if (!obj[$changes]) {
                console.warn("StateView#add(), invalid object:", obj);
                return this;
            }
            // FIXME: ArraySchema/MapSchema does not have metadata
            const metadata = obj.constructor[Symbol.metadata];
            let changeTree = obj[$changes];
            this.items.add(changeTree);
            // Add children of this ChangeTree to this view
            changeTree.forEachChild((change, index) => {
                // Do not ADD children that don't have the same tag
                if (metadata && metadata[metadata[index]].tag !== tag) {
                    return;
                }
                this.add(change.ref, tag);
            });
            // add parent ChangeTree's, if they are invisible to this view
            // TODO: REFACTOR addParent()
            this.addParent(changeTree, tag);
            //
            // TODO: when adding an item of a MapSchema, the changes may not
            // be set (only the parent's changes are set)
            //
            let changes = this.changes.get(changeTree);
            if (changes === undefined) {
                changes = new Map();
                this.changes.set(changeTree, changes);
            }
            // set tag
            if (tag !== DEFAULT_VIEW_TAG) {
                if (!this.tags) {
                    this.tags = new WeakMap();
                }
                let tags;
                if (!this.tags.has(changeTree)) {
                    tags = new Set();
                    this.tags.set(changeTree, tags);
                }
                else {
                    tags = this.tags.get(changeTree);
                }
                tags.add(tag);
                // Ref: add tagged properties
                metadata?.[-3]?.[tag]?.forEach((index) => {
                    if (changeTree.getChange(index) !== exports.OPERATION.DELETE) {
                        changes.set(index, exports.OPERATION.ADD);
                    }
                });
            }
            else {
                // console.log("DEFAULT TAG", changeTree.allChanges);
                // // add default tag properties
                // metadata?.[-3]?.[DEFAULT_VIEW_TAG]?.forEach((index) => {
                //     if (changeTree.getChange(index) !== OPERATION.DELETE) {
                //         changes.set(index, OPERATION.ADD);
                //     }
                // });
                const allChangesSet = (changeTree.isFiltered || changeTree.isPartiallyFiltered)
                    ? changeTree.allFilteredChanges
                    : changeTree.allChanges;
                const it = allChangesSet.keys();
                const isInvisible = this.invisible.has(changeTree);
                for (const index of it) {
                    if ((isInvisible || metadata?.[metadata?.[index]].tag === tag) &&
                        changeTree.getChange(index) !== exports.OPERATION.DELETE) {
                        changes.set(index, exports.OPERATION.ADD);
                    }
                }
            }
            // TODO: avoid unnecessary iteration here
            while (changeTree.parent &&
                (changeTree = changeTree.parent[$changes]) &&
                (changeTree.isFiltered || changeTree.isPartiallyFiltered)) {
                this.items.add(changeTree);
            }
            return this;
        }
        addParent(changeTree, tag) {
            const parentRef = changeTree.parent;
            if (!parentRef) {
                return;
            }
            const parentChangeTree = parentRef[$changes];
            const parentIndex = changeTree.parentIndex;
            if (!this.invisible.has(parentChangeTree)) {
                // parent is already available, no need to add it!
                return;
            }
            this.addParent(parentChangeTree, tag);
            // add parent's tag properties
            if (parentChangeTree.getChange(parentIndex) !== exports.OPERATION.DELETE) {
                let parentChanges = this.changes.get(parentChangeTree);
                if (parentChanges === undefined) {
                    parentChanges = new Map();
                    this.changes.set(parentChangeTree, parentChanges);
                }
                // console.log("add parent change", {
                //     parentIndex,
                //     parentChanges,
                //     parentChange: (
                //         parentChangeTree.getChange(parentIndex) &&
                //         OPERATION[parentChangeTree.getChange(parentIndex)]
                //     ),
                // })
                if (!this.tags) {
                    this.tags = new WeakMap();
                }
                let tags;
                if (!this.tags.has(parentChangeTree)) {
                    tags = new Set();
                    this.tags.set(parentChangeTree, tags);
                }
                else {
                    tags = this.tags.get(parentChangeTree);
                }
                tags.add(tag);
                parentChanges.set(parentIndex, exports.OPERATION.ADD);
            }
        }
        remove(obj, tag = DEFAULT_VIEW_TAG) {
            const changeTree = obj[$changes];
            if (!changeTree) {
                console.warn("StateView#remove(), invalid object:", obj);
                return this;
            }
            this.items.delete(changeTree);
            const ref = changeTree.ref;
            const metadata = ref.constructor[Symbol.metadata];
            let changes = this.changes.get(changeTree);
            if (changes === undefined) {
                changes = new Map();
                this.changes.set(changeTree, changes);
            }
            if (tag === DEFAULT_VIEW_TAG) {
                // parent is collection (Map/Array)
                const parent = changeTree.parent;
                if (!Metadata.isValidInstance(parent)) {
                    const parentChangeTree = parent[$changes];
                    let changes = this.changes.get(parentChangeTree);
                    if (changes === undefined) {
                        changes = new Map();
                        this.changes.set(parentChangeTree, changes);
                    }
                    // DELETE / DELETE BY REF ID
                    changes.set(changeTree.parentIndex, exports.OPERATION.DELETE);
                }
                else {
                    // delete all "tagged" properties.
                    metadata[-2].forEach((index) => changes.set(index, exports.OPERATION.DELETE));
                }
            }
            else {
                // delete only tagged properties
                metadata[-3][tag].forEach((index) => changes.set(index, exports.OPERATION.DELETE));
            }
            // remove tag
            if (this.tags && this.tags.has(changeTree)) {
                const tags = this.tags.get(changeTree);
                if (tag === undefined) {
                    // delete all tags
                    this.tags.delete(changeTree);
                }
                else {
                    // delete specific tag
                    tags.delete(tag);
                    // if tag set is empty, delete it entirely
                    if (tags.size === 0) {
                        this.tags.delete(changeTree);
                    }
                }
            }
            return this;
        }
    }

    registerType("map", { constructor: MapSchema });
    registerType("array", { constructor: ArraySchema });
    registerType("set", { constructor: SetSchema });
    registerType("collection", { constructor: CollectionSchema, });

    exports.$changes = $changes;
    exports.$childType = $childType;
    exports.$decoder = $decoder;
    exports.$deleteByIndex = $deleteByIndex;
    exports.$encoder = $encoder;
    exports.$filter = $filter;
    exports.$getByIndex = $getByIndex;
    exports.$track = $track;
    exports.ArraySchema = ArraySchema;
    exports.ChangeTree = ChangeTree;
    exports.CollectionSchema = CollectionSchema;
    exports.Decoder = Decoder;
    exports.Encoder = Encoder;
    exports.MapSchema = MapSchema;
    exports.Metadata = Metadata;
    exports.Reflection = Reflection;
    exports.ReflectionField = ReflectionField;
    exports.ReflectionType = ReflectionType;
    exports.Schema = Schema;
    exports.SetSchema = SetSchema;
    exports.StateView = StateView;
    exports.TypeContext = TypeContext;
    exports.decode = decode;
    exports.decodeKeyValueOperation = decodeKeyValueOperation;
    exports.decodeSchemaOperation = decodeSchemaOperation;
    exports.defineTypes = defineTypes;
    exports.deprecated = deprecated;
    exports.dumpChanges = dumpChanges;
    exports.encode = encode;
    exports.encodeKeyValueOperation = encodeArray;
    exports.encodeSchemaOperation = encodeSchemaOperation;
    exports.getDecoderStateCallbacks = getDecoderStateCallbacks;
    exports.getRawChangesCallback = getRawChangesCallback;
    exports.registerType = registerType;
    exports.type = type;
    exports.view = view;

}));
