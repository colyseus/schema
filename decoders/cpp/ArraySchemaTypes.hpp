// 
// THIS FILE HAS BEEN GENERATED AUTOMATICALLY
// DO NOT CHANGE IT MANUALLY UNLESS YOU KNOW WHAT YOU'RE DOING
// 
// GENERATED USING @colyseus/schema 0.4.48
// 
#ifndef __SCHEMA_CODEGEN_ARRAYSCHEMATYPES_H__
#define __SCHEMA_CODEGEN_ARRAYSCHEMATYPES_H__ 1

#include "schema.h"
#include <typeinfo>
#include <typeindex>

#include "IAmAChild.hpp"

using namespace colyseus::schema;


class ArraySchemaTypes : public Schema {
public:
	 ArraySchema<IAmAChild*> *arrayOfSchemas = new ArraySchema<IAmAChild*>();
	 ArraySchema<varint_t> *arrayOfNumbers = new ArraySchema<varint_t>();
	 ArraySchema<string> *arrayOfStrings = new ArraySchema<string>();
	 ArraySchema<int32_t> *arrayOfInt32 = new ArraySchema<int32_t>();

	ArraySchemaTypes() {
		this->_indexes = {{0, "arrayOfSchemas"}, {1, "arrayOfNumbers"}, {2, "arrayOfStrings"}, {3, "arrayOfInt32"}};
		this->_types = {{0, "array"}, {1, "array"}, {2, "array"}, {3, "array"}};
		this->_childPrimitiveTypes = {{1, "number"}, {2, "string"}, {3, "int32"}};
		this->_childSchemaTypes = {{0, typeid(IAmAChild)}};
	}

	~ArraySchemaTypes() {
		delete this->arrayOfSchemas;
		delete this->arrayOfNumbers;
		delete this->arrayOfStrings;
		delete this->arrayOfInt32;
	}

protected:
	ArraySchema<char*> * getArray(string field)
	{
		if (field == "arrayOfSchemas")
		{
			return (ArraySchema<char*> *)this->arrayOfSchemas;

		} else if (field == "arrayOfNumbers")
		{
			return (ArraySchema<char*> *)this->arrayOfNumbers;

		} else if (field == "arrayOfStrings")
		{
			return (ArraySchema<char*> *)this->arrayOfStrings;

		} else if (field == "arrayOfInt32")
		{
			return (ArraySchema<char*> *)this->arrayOfInt32;

		}
		return Schema::getArray(field);
	}

	void setArray(string field, ArraySchema<char*> * value)
	{
		if (field == "arrayOfSchemas")
		{
			this->arrayOfSchemas = (ArraySchema<IAmAChild*> *)value;
			return;

		} else if (field == "arrayOfNumbers")
		{
			this->arrayOfNumbers = (ArraySchema<varint_t> *)value;
			return;

		} else if (field == "arrayOfStrings")
		{
			this->arrayOfStrings = (ArraySchema<string> *)value;
			return;

		} else if (field == "arrayOfInt32")
		{
			this->arrayOfInt32 = (ArraySchema<int32_t> *)value;
			return;

		}
		return Schema::setArray(field, value);
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
