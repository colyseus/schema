import { Sync, sync } from "./annotations";

export class Player {}

export class State extends Sync {
  @sync
  fieldString: string;

  @sync
  fieldNumber: number;

  // // fieldString: string;
  // private _fieldString: string;
  // set fieldString(value: string) {
  //   this._fieldString = value;

  //   const fieldOffset = 0;

  //   const previousLength = this._bytes[fieldOffset]
  //   const newLength = utf8Length(value);

  //   this._bytes[fieldOffset] = newLength;

  //   var bytes: number[] = [];
  //   var size: number;

  //   // fixstr
  //   if (newLength < 0x20) {
  //     bytes.push(newLength | 0xa0);
  //     size = 1;
  //   }
  //   // str 8
  //   else if (newLength < 0x100) {
  //     bytes.push(0xd9, newLength);
  //     size = 2;
  //   }
  //   // str 16
  //   else if (newLength < 0x10000) {
  //     bytes.push(0xda, newLength >> 8, newLength);
  //     size = 3;
  //   }
  //   // str 32
  //   else if (newLength < 0x100000000) {
  //     bytes.push(0xdb, newLength >> 24, newLength >> 16, newLength >> 8, newLength);
  //     size = 5;

  //   } else {
  //     throw new Error('String too long');
  //   }

  //   utf8Write(bytes, bytes.length, value);
  //   this._bytes.splice(fieldOffset, previousLength, ...bytes);
  // }

  // get fieldString() {
  //   const offset = 0;
  //   const prefix = this._bytes[offset];
  //   return utf8Read(this._bytes, offset+1, prefix);
  // }

  // // fieldNumber: number;
  // set fieldNumber(value: number) { }
  // get fieldNumber() { return 0; }

  // // fieldBoolean: boolean;
  // set fieldBoolean(value: boolean) { }
  // get fieldBoolean() { return true; }

  // // fieldArray: Array<number>;
  // set fieldArray(value: Array<number>) { }
  // get fieldArray() { return new Array<number>(); }

  // // fieldDate: Date;
  // set fieldDate(value: Date) { }
  // get fieldDate() { return new Date() }

  // // fieldMap: Map<string, number>;
  // set fieldMap(value: Map<string, number>) { }
  // get fieldMap() { return new Map<string, number>(); }

  // // fieldPlayer: Player;
  // set fieldPlayer(value: Player) { }
  // get fieldPlayer() { return new Player(); }
}
