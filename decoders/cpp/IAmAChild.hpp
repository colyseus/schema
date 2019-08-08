// 
// THIS FILE HAS BEEN GENERATED AUTOMATICALLY
// DO NOT CHANGE IT MANUALLY UNLESS YOU KNOW WHAT YOU'RE DOING
// 
// GENERATED USING @colyseus/schema 0.4.48
// 
#ifndef __SCHEMA_CODEGEN_IAMACHILD_H__
#define __SCHEMA_CODEGEN_IAMACHILD_H__ 1

#include "schema.h"
#include <typeinfo>
#include <typeindex>



using namespace colyseus::schema;


class IAmAChild : public Schema {
public:
	 varint_t x = 0;
	 varint_t y = 0;

	IAmAChild() {
		this->_indexes = {{0, "x"}, {1, "y"}};
		this->_types = {{0, "number"}, {1, "number"}};
		this->_childPrimitiveTypes = {};
		this->_childSchemaTypes = {};
	}

	~IAmAChild() {
		
	}

protected:
	varint_t getNumber(string field)
	{
		if (field == "x")
		{
			return this->x;

		} else if (field == "y")
		{
			return this->y;

		}
		return Schema::getNumber(field);
	}

	void setNumber(string field, varint_t value)
	{
		if (field == "x")
		{
			this->x = value;
			return;

		} else if (field == "y")
		{
			this->y = value;
			return;

		}
		return Schema::setNumber(field, value);
	}


};


#endif
