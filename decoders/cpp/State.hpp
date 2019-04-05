// 
// THIS FILE HAS BEEN GENERATED AUTOMATICALLY
// DO NOT CHANGE IT MANUALLY UNLESS YOU KNOW WHAT YOU'RE DOING
// 
// GENERATED USING @colyseus/schema 0.4.18
// 
#ifndef __SCHEMA_CODEGEN_STATE_H__
#define __SCHEMA_CODEGEN_STATE_H__ 1

#include "schema.h"
#include <typeinfo>
#include <typeindex>

#include "Player.hpp"

using namespace colyseus::schema;


class State : public Schema {
public:
	 ArraySchema<string*> arrayOfStrings = ArraySchema<string*>();
	 ArraySchema<varint_t> arrayOfNumbers = ArraySchema<varint_t>();
	 ArraySchema<Player*> arrayOfPlayers = ArraySchema<Player*>();
	 MapSchema<string*> mapOfStrings = MapSchema<string*>();
	 MapSchema<varint_t> mapOfNumbers = MapSchema<varint_t>();
	 MapSchema<Player*> mapOfPlayers = MapSchema<Player*>();

	State() {
		this->_indexes = {{0, "arrayOfStrings"}, {1, "arrayOfNumbers"}, {2, "arrayOfPlayers"}, {3, "mapOfStrings"}, {4, "mapOfNumbers"}, {5, "mapOfPlayers"}};
		this->_types = {{0, "array"}, {1, "array"}, {2, "array"}, {3, "map"}, {4, "map"}, {5, "map"}};
		this->_childPrimitiveTypes = {{0, "string"}, {1, "number"}, {3, "string"}, {4, "number"}};
		this->_childSchemaTypes = {{2, typeid(Player)}, {5, typeid(Player)}};
	}

protected:
	ArraySchema<char*> getArray(string field)
	{
		if (field == "arrayOfStrings")
		{
			return *(ArraySchema<char*> *)& this->arrayOfStrings;

		} else if (field == "arrayOfNumbers")
		{
			return *(ArraySchema<char*> *)& this->arrayOfNumbers;

		} else if (field == "arrayOfPlayers")
		{
			return *(ArraySchema<char*> *)& this->arrayOfPlayers;

		}
		return Schema::getArray(field);
	}

	void setArray(string field, ArraySchema<char*> value)
	{
		if (field == "arrayOfStrings")
		{
			this->arrayOfStrings = *(ArraySchema<string*> *)&value;

		} else if (field == "arrayOfNumbers")
		{
			this->arrayOfNumbers = *(ArraySchema<varint_t> *)&value;

		} else if (field == "arrayOfPlayers")
		{
			this->arrayOfPlayers = *(ArraySchema<Player*> *)&value;

		}
	}
	MapSchema<char*> getMap(string field)
	{
		if (field == "mapOfStrings")
		{
			return *(MapSchema<char*> *)& this->mapOfStrings;

		} else if (field == "mapOfNumbers")
		{
			return *(MapSchema<char*> *)& this->mapOfNumbers;

		} else if (field == "mapOfPlayers")
		{
			return *(MapSchema<char*> *)& this->mapOfPlayers;

		}
		return Schema::getMap(field);
	}

	void setMap(string field, MapSchema<char*> value)
	{
		if (field == "mapOfStrings")
		{
			this->mapOfStrings = *(MapSchema<string*> *)&value;

		} else if (field == "mapOfNumbers")
		{
			this->mapOfNumbers = *(MapSchema<varint_t> *)&value;

		} else if (field == "mapOfPlayers")
		{
			this->mapOfPlayers = *(MapSchema<Player*> *)&value;

		}
	}

	Schema* createInstance(std::type_index type) {
		if (type == typeid(Player))
		{
			return new Player();

		}
		return Schema::createInstance(type);
	}
};


#endif
