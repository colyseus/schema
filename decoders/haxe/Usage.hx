// package io.colyseus.serializer.schema;

import Schema; 
import haxe.io.Bytes;
import haxe.io.BytesOutput;

class Usage {

    static function main() {
        var arr: Array<Int> = [2, 0, 100, 1, 204, 200, 2, 173, 74, 97, 107, 101, 32, 66, 97, 100, 108, 97, 110, 100, 115, 193, 1, 50, 0, 164, 72, 101, 121, 33 ];

        var s = new State();
        s.decode(getBytes(arr));

        trace(s);

    }

    static function getBytes(data: Array<Int>): Bytes {
        var bytes = new BytesOutput();

        for (i in data) {
            bytes.writeByte(i);
        }

        return bytes.getBytes();
    }
}
