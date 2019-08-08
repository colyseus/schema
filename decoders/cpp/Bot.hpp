// 
// THIS FILE HAS BEEN GENERATED AUTOMATICALLY
// DO NOT CHANGE IT MANUALLY UNLESS YOU KNOW WHAT YOU'RE DOING
// 
// GENERATED USING @colyseus/schema 0.4.48
// 
#ifndef __SCHEMA_CODEGEN_BOT_H__
#define __SCHEMA_CODEGEN_BOT_H__ 1

#include "schema.h"
#include <typeinfo>
#include <typeindex>

#include "Player.hpp"
#include "Entity.hpp"

using namespace colyseus::schema;


class Bot : public Player {
public:
	 varint_t power = 0;

	Bot() {
		this->_indexes = {{0, "x"}, {1, "y"}, {2, "name"}, {3, "power"}};
		this->_types = {{0, "number"}, {1, "number"}, {2, "string"}, {3, "number"}};
		this->_childPrimitiveTypes = {};
		this->_childSchemaTypes = {};
	}

	~Bot() {
		
	}

protected:
	varint_t getNumber(string field)
	{
		if (field == "power")
		{
			return this->power;

		}
		return Player::getNumber(field);
	}

	void setNumber(string field, varint_t value)
	{
		if (field == "power")
		{
			this->power = value;
			return;

		}
		return Player::setNumber(field, value);
	}


};


#endif
