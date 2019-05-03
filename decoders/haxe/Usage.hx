import io.colyseus.serializer.schema.Schema;
import haxe.io.Bytes;
import haxe.io.BytesOutput;

class Usage {

    static function main() {
        var arr: Array<Int> = [2, 0, 100, 1, 204, 200, 2, 173, 74, 97, 107, 101, 32, 66, 97, 100, 108, 97, 110, 100, 115, 193, 3, 3, 3, 0, 163, 111, 110, 101, 1, 163, 116, 119, 111, 2, 165, 116, 104, 114, 101, 101, 4, 3, 3, 0, 1, 1, 2, 2, 3, 5, 3, 3, 0, 0, 100, 1, 100, 2, 163, 80, 65, 49, 193, 1, 0, 204, 200, 1, 204, 200, 2, 163, 80, 65, 50, 193, 2, 0, 204, 250, 1, 204, 250, 2, 163, 80, 65, 51, 193, 6, 3, 163, 111, 110, 101, 164, 79, 78, 69, 33, 163, 116, 119, 111, 164, 84, 87, 79, 33, 165, 116, 104, 114, 101, 101, 166, 84, 72, 82, 69, 69, 33, 7, 0, 8, 3, 163, 111, 110, 101, 0, 100, 1, 100, 2, 163, 80, 77, 49, 193, 163, 116, 119, 111, 0, 204, 200, 1, 204, 200, 2, 163, 80, 77, 50, 193, 165, 116, 104, 114, 101, 101, 0, 204, 250, 1, 204, 250, 2, 172, 80, 108, 97, 121, 101, 114, 32, 84, 104, 114, 101, 101, 193, 1, 50, 0, 164, 72, 101, 121, 33];
        var s = new State();

        s.decode(getBytes(arr));

        trace("DECODED!");

        trace("myString", s.myString);
        trace("myNumber", s.myNumber);
        trace("player", s.player);

        trace(s.arrayOfNumbers);
        for (item in s.arrayOfNumbers) {
            trace("array of numbers:");
            trace(item);
        }

        trace(s.arrayOfStrings);
        for (item in s.arrayOfStrings) {
            trace("array of strings:");
            // var player: Player = cast item;
            trace(item);
        }

        trace(s.arrayOfPlayers);
        for (item in s.arrayOfPlayers) {
            trace("array of players:");
            // var player: Player = cast item;
            trace(item.name + ", " + item.x + " / " + item.y);
        }

        trace(s.mapOfPlayers);
        for (item in s.mapOfPlayers) {
            trace("map of players:");
            // var player: Player = cast item;
            trace(item.name + ", " + item.x + " / " + item.y);
        }

        trace(s.mapOfStrings);
        for (item in s.mapOfStrings) {
            trace("map of strings:");
            // var player: Player = cast item;
            trace(item);
        }

        trace("END");

    }

    static function getBytes(data: Array<Int>): Bytes {
        var bytes = new BytesOutput();

        for (i in data) {
            bytes.writeByte(i);
        }

        return bytes.getBytes();
    }
}
