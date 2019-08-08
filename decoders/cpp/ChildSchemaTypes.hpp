// 
// THIS FILE HAS BEEN GENERATED AUTOMATICALLY
// DO NOT CHANGE IT MANUALLY UNLESS YOU KNOW WHAT YOU'RE DOING
// 
// GENERATED USING @colyseus/schema 0.4.48
// 
#ifndef __SCHEMA_CODEGEN_CHILDSCHEMATYPES_H__
#define __SCHEMA_CODEGEN_CHILDSCHEMATYPES_H__ 1

#include "schema.h"
#include <typeinfo>
#include <typeindex>

#include "IAmAChild.hpp"

using namespace colyseus::schema;


class ChildSchemaTypes : public Schema {
public:
	 IAmAChild *child = new IAmAChild();
	 IAmAChild *secondChild = new IAmAChild();

	ChildSchemaTypes() {
		this->_indexes = {{0, "child"}, {1, "secondChild"}};
		this->_types = {{0, "ref"}, {1, "ref"}};
		this->_childPrimitiveTypes = {};
		this->_childSchemaTypes = {{0, typeid(IAmAChild)}, {1, typeid(IAmAChild)}};
	}

	~ChildSchemaTypes() {
		delete this->child;
		delete this->secondChild;
	}

protected:
	Schema* getRef(string field)
	{
		if (field == "child")
		{
			return this->child;

		} else if (field == "secondChild")
		{
			return this->secondChild;

		}
		return Schema::getRef(field);
	}

	void setRef(string field, Schema* value)
	{
		if (field == "child")
		{
			this->child = (IAmAChild*)value;
			return;

		} else if (field == "secondChild")
		{
			this->secondChild = (IAmAChild*)value;
			return;

		}
		return Schema::setRef(field, value);
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
