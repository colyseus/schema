// 
// THIS FILE HAS BEEN GENERATED AUTOMATICALLY
// DO NOT CHANGE IT MANUALLY UNLESS YOU KNOW WHAT YOU'RE DOING
// 
// GENERATED USING @colyseus/schema 0.4.48
// 
#ifndef __SCHEMA_CODEGEN_MAPSCHEMATYPES_H__
#define __SCHEMA_CODEGEN_MAPSCHEMATYPES_H__ 1

#include "schema.h"
#include <typeinfo>
#include <typeindex>

#include "IAmAChild.hpp"

using namespace colyseus::schema;


class MapSchemaTypes : public Schema {
public:
	 MapSchema<IAmAChild*> *mapOfSchemas = new MapSchema<IAmAChild*>();
	 MapSchema<varint_t> *mapOfNumbers = new MapSchema<varint_t>();
	 MapSchema<string> *mapOfStrings = new MapSchema<string>();
	 MapSchema<int32_t> *mapOfInt32 = new MapSchema<int32_t>();

	MapSchemaTypes() {
		this->_indexes = {{0, "mapOfSchemas"}, {1, "mapOfNumbers"}, {2, "mapOfStrings"}, {3, "mapOfInt32"}};
		this->_types = {{0, "map"}, {1, "map"}, {2, "map"}, {3, "map"}};
		this->_childPrimitiveTypes = {{1, "number"}, {2, "string"}, {3, "int32"}};
		this->_childSchemaTypes = {{0, typeid(IAmAChild)}};
	}

	~MapSchemaTypes() {
		delete this->mapOfSchemas;
		delete this->mapOfNumbers;
		delete this->mapOfStrings;
		delete this->mapOfInt32;
	}

protected:
	MapSchema<char*> * getMap(string field)
	{
		if (field == "mapOfSchemas")
		{
			return (MapSchema<char*> *)this->mapOfSchemas;

		} else if (field == "mapOfNumbers")
		{
			return (MapSchema<char*> *)this->mapOfNumbers;

		} else if (field == "mapOfStrings")
		{
			return (MapSchema<char*> *)this->mapOfStrings;

		} else if (field == "mapOfInt32")
		{
			return (MapSchema<char*> *)this->mapOfInt32;

		}
		return Schema::getMap(field);
	}

	void setMap(string field, MapSchema<char*> * value)
	{
		if (field == "mapOfSchemas")
		{
			this->mapOfSchemas = (MapSchema<IAmAChild*> *)value;
			return;

		} else if (field == "mapOfNumbers")
		{
			this->mapOfNumbers = (MapSchema<varint_t> *)value;
			return;

		} else if (field == "mapOfStrings")
		{
			this->mapOfStrings = (MapSchema<string> *)value;
			return;

		} else if (field == "mapOfInt32")
		{
			this->mapOfInt32 = (MapSchema<int32_t> *)value;
			return;

		}
		return Schema::setMap(field, value);
	}

	Schema* createInstance(std::type_index type) {
		if (type == typeid(IAmAChild))
		{
			return new IAmAChild();

		}
		return Schema::createInstance(type);
	}
};


#endif
