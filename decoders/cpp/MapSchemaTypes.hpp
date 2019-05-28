//
// THIS FILE HAS BEEN GENERATED AUTOMATICALLY
// DO NOT CHANGE IT MANUALLY UNLESS YOU KNOW WHAT YOU'RE DOING
//
// GENERATED USING @colyseus/schema 0.4.34
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
	 MapSchema<IAmAChild*> mapOfSchemas = MapSchema<IAmAChild*>();
	 MapSchema<varint_t> mapOfNumbers = MapSchema<varint_t>();

	MapSchemaTypes() {
		this->_indexes = {{0, "mapOfSchemas"}, {1, "mapOfNumbers"}};
		this->_types = {{0, "map"}, {1, "map"}};
		this->_childPrimitiveTypes = {{1, "number"}};
		this->_childSchemaTypes = {{0, typeid(IAmAChild)}};
	}

protected:
	MapSchema<char*> getMap(string field)
	{
		if (field == "mapOfSchemas")
		{
			return *(MapSchema<char*> *)& this->mapOfSchemas;

		} else if (field == "mapOfNumbers")
		{
			return *(MapSchema<char*> *)& this->mapOfNumbers;

		}
		return Schema::getMap(field);
	}

	void setMap(string field, MapSchema<char*> value)
	{
		if (field == "mapOfSchemas")
		{
			this->mapOfSchemas = *(MapSchema<IAmAChild*> *)&value;

		} else if (field == "mapOfNumbers")
		{
			this->mapOfNumbers = *(MapSchema<varint_t> *)&value;

		}
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
