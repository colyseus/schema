// package io.colyseus.serializer.schema;
import haxe.io.Bytes;

class It {
  public var offset: Int = 0;
  public function new () {}
}

class SPEC {
  public static var END_OF_STRUCTURE: Int = 193; // (msgpack spec: never used)
  public static var NIL: Int = 192;
  public static var INDEX_CHANGE: Int = 212;

  public static function numberCheck (bytes: Bytes, it: It) {
    var prefix = bytes.get(it.offset);
    return (prefix < 0x80 || (prefix >= 0xca && prefix <= 0xd3));
  }

  public static function arrayCheck (bytes: Bytes, it: It) {
    return bytes.get(it.offset) < 0xa0;
  }

  public static function nilCheck(bytes: Bytes, it: It) {
    return bytes.get(it.offset) == NIL;
  }

  public static function indexChangeCheck(bytes: Bytes, it: It) {
    return bytes.get(it.offset) == INDEX_CHANGE;
  }

  public static function stringCheck(bytes, it: It) {
    var prefix = bytes.get(it.offset);
    return (
      // fixstr
      (prefix < 0xc0 && prefix > 0xa0) ||
      // str 8
      prefix == 0xd9 ||
      // str 16
      prefix == 0xda ||
      // str 32
      prefix == 0xdb
    );
  }
}

class Decoder {
  public function new () {}

  public function decodePrimitiveType(type: String, bytes: Bytes, it: It): Dynamic {
    switch (type) {
      case "string": return this.string(bytes, it);
      case "number": return this.number(bytes, it);
      case "boolean": return this.boolean(bytes, it);
      case "int8": return this.int8(bytes, it);
      case "uint8": return this.uint8(bytes, it);
      case "int16": return this.int16(bytes, it);
      case "uint16": return this.uint16(bytes, it);
      case "int32": return this.int32(bytes, it);
      case "uint32": return this.uint32(bytes, it);
      case "int64": return this.int64(bytes, it);
      case "uint64": return this.uint64(bytes, it);
      case "float32": return this.float32(bytes, it);
      case "float64": return this.float64(bytes, it);
      default: 
        throw "can't decode: " + type;

    }
  }

  public function string (bytes: Bytes, it: It) {
    var length = bytes.get(it.offset++) & 0x1f;
    var str = bytes.getString(it.offset, length);
    it.offset += length;
    return str;
  }

  public function number (bytes: Bytes, it: It): Dynamic {
    var prefix = bytes.get(it.offset++);

    if (prefix < 0x80) {
      // positive fixint
      return prefix;

    } else if (prefix == 0xca) {
      // float 32
      return this.float32(bytes, it);

    } else if (prefix == 0xcb) {
      // float 64
      return this.float64(bytes, it);

    } else if (prefix == 0xcc) {
      // uint 8
      return this.uint8(bytes, it);

    } else if (prefix == 0xcd) {
      // uint 16
      return this.uint16(bytes, it);

    } else if (prefix == 0xce) {
      // uint 32
      return this.uint32(bytes, it);

    } else if (prefix == 0xcf) {
      // uint 64
      return this.uint64(bytes, it);

    } else if (prefix == 0xd0) {
      // int 8
      return this.int8(bytes, it);

    } else if (prefix == 0xd1) {
      // int 16
      return this.int16(bytes, it);

    } else if (prefix == 0xd2) {
      // int 32
      return this.int32(bytes, it);

    } else if (prefix == 0xd3) {
      // int 64
      return this.int64(bytes, it);

    } else if (prefix > 0xdf) {
      // negative fixint
      return (0xff - prefix + 1) * -1;
    }

    return 0;
  }

  public function boolean (bytes: Bytes, it: It) {
    return this.uint8(bytes, it) > 0;
  }

  public function int8 (bytes: Bytes, it: It) {
    return this.uint8(bytes, it) << 24 >> 24;
  }

  public function uint8 (bytes: Bytes, it: It)  {
    return bytes.get(it.offset++);
  }

  public function int16 (bytes: Bytes, it: It) {
    return this.uint16(bytes, it) << 16 >> 16;
  }

  public function uint16 (bytes: Bytes, it: It) {
    return bytes.get(it.offset++) | bytes.get(it.offset++) << 8;
  }

  public function int32 (bytes: Bytes, it: It)  {
    var value = bytes.getInt32(it.offset);
    it.offset += 4;
    return value;
  }

  public function uint32 (bytes: Bytes, it: It) {
    return this.int32(bytes, it) >>> 0;
  }

  public function int64 (bytes: Bytes, it: It) {
    var value = bytes.getInt64(it.offset);
    it.offset += 8;
    return value;
  }

  public function uint64 (bytes: Bytes, it: It) {
    var low = this.uint32(bytes, it);
    var high = this.uint32(bytes, it) * Math.pow(2, 32);
    return high + low;
  }

  public function float32 (bytes: Bytes, it: It) {
    var value = bytes.getFloat(it.offset);
    it.offset += 4;
    return value;
  }

  public function float64 (bytes: Bytes, it: It) {
    var value = bytes.getDouble(it.offset);
    it.offset += 8;
    return value;
  }

}

class DataChange {
  public var field: String;
  public var value: Dynamic;
  public var previousValue: Dynamic;
  public function new (field: String, value: Dynamic, previousValue: Dynamic) {
    this.field = field;
    this.value = value;
    this.previousValue = previousValue;
  }
}

class Schema {
  public function new () {}

  public dynamic function onChange(changes: Array<DataChange>): Void {}
  public dynamic function onRemove(): Void {}

  private var _indexes: Map<Int, String> = [];
  private var _types: Map<Int, String> = [];
  private var _childSchemaTypes: Map<Int, Class<Schema>> = [];
  private var _childPrimitiveTypes: Map<Int, String> = [];

  private static var decoder = new Decoder();

  public function decode(bytes: Bytes, it: It = null) {
    var changes: Array<DataChange> = [];

    if (it == null) {
      it = new It();
    }

    var totalBytes = bytes.length;
    while (it.offset < totalBytes) {
      var index = bytes.get(it.offset++);

      if (index == SPEC.END_OF_STRUCTURE) {
          // reached end of strucutre. skip.
          break;
      }

      var field = this._indexes.get(index);
      var type = this._types.get(index);

      var value: Dynamic = null;
      var change: Dynamic = null; // for triggering onChange 
      var hasChange = false;

      if (type == "ref") {
        if (SPEC.nilCheck(bytes, it)) {
          it.offset++;
          value = null;

        } else {
          var constructor: Class<Schema> = this._childSchemaTypes[index];
          value = Reflect.getProperty(this, field);
          if (value == null) { value = Type.createInstance(constructor, []); }
          value.decode(bytes, it);
        }

        hasChange = true;

      } else if (type == "array") {

      } else if (type == "map") {

      } else {
        value = decoder.decodePrimitiveType(type, bytes, it);
        hasChange = true;
      }

      if (hasChange) {
        changes.push(new DataChange(
          field, 
          (change == null) ? value : change,
          Reflect.getProperty(this, field)
        ));
      }

      Reflect.setProperty(this, field, value);
    }

    if (changes.length > 0) {
        this.onChange(changes);
    }
  }
}
