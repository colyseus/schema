// 
// THIS FILE HAS BEEN GENERATED AUTOMATICALLY
// DO NOT CHANGE IT MANUALLY UNLESS YOU KNOW WHAT YOU'RE DOING
// 
// GENERATED USING @colyseus/schema 0.4.19
// 



class Player extends Entity {
	public var name: String = "";

  
	public function new () {
		super();
		this._indexes = [0 => "x", 1 => "y", 2 => "name"];
		this._types = [0 => "number", 1 => "number", 2 => "string"];
		this._childPrimitiveTypes = [];
		this._childSchemaTypes = [];
	}

}

