// 
// THIS FILE HAS BEEN GENERATED AUTOMATICALLY
// DO NOT CHANGE IT MANUALLY UNLESS YOU KNOW WHAT YOU'RE DOING
// 
// GENERATED USING @colyseus/schema 0.4.48
// 
#ifndef __SCHEMA_CODEGEN_PLAYER_H__
#define __SCHEMA_CODEGEN_PLAYER_H__ 1

#include "schema.h"
#include <typeinfo>
#include <typeindex>

#include "Entity.hpp"

using namespace colyseus::schema;


class Player : public Entity {
public:
	 string name = "";

	Player() {
		this->_indexes = {{0, "x"}, {1, "y"}, {2, "name"}};
		this->_types = {{0, "number"}, {1, "number"}, {2, "string"}};
		this->_childPrimitiveTypes = {};
		this->_childSchemaTypes = {};
	}

	~Player() {
		
	}

protected:
	string getString(string field)
	{
		if (field == "name")
		{
			return this->name;

		}
		return Entity::getString(field);
	}

	void setString(string field, string value)
	{
		if (field == "name")
		{
			this->name = value;
			return;

		}
		return Entity::setString(field, value);
	}


};


#endif
