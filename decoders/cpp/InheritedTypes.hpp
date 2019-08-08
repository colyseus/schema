// 
// THIS FILE HAS BEEN GENERATED AUTOMATICALLY
// DO NOT CHANGE IT MANUALLY UNLESS YOU KNOW WHAT YOU'RE DOING
// 
// GENERATED USING @colyseus/schema 0.4.48
// 
#ifndef __SCHEMA_CODEGEN_INHERITEDTYPES_H__
#define __SCHEMA_CODEGEN_INHERITEDTYPES_H__ 1

#include "schema.h"
#include <typeinfo>
#include <typeindex>

#include "Entity.hpp"
#include "Player.hpp"
#include "Bot.hpp"

using namespace colyseus::schema;


class InheritedTypes : public Schema {
public:
	 Entity *entity = new Entity();
	 Player *player = new Player();
	 Bot *bot = new Bot();
	 Entity *any = new Entity();

	InheritedTypes() {
		this->_indexes = {{0, "entity"}, {1, "player"}, {2, "bot"}, {3, "any"}};
		this->_types = {{0, "ref"}, {1, "ref"}, {2, "ref"}, {3, "ref"}};
		this->_childPrimitiveTypes = {};
		this->_childSchemaTypes = {{0, typeid(Entity)}, {1, typeid(Player)}, {2, typeid(Bot)}, {3, typeid(Entity)}};
	}

	~InheritedTypes() {
		delete this->entity;
		delete this->player;
		delete this->bot;
		delete this->any;
	}

protected:
	Schema* getRef(string field)
	{
		if (field == "entity")
		{
			return this->entity;

		} else if (field == "player")
		{
			return this->player;

		} else if (field == "bot")
		{
			return this->bot;

		} else if (field == "any")
		{
			return this->any;

		}
		return Schema::getRef(field);
	}

	void setRef(string field, Schema* value)
	{
		if (field == "entity")
		{
			this->entity = (Entity*)value;
			return;

		} else if (field == "player")
		{
			this->player = (Player*)value;
			return;

		} else if (field == "bot")
		{
			this->bot = (Bot*)value;
			return;

		} else if (field == "any")
		{
			this->any = (Entity*)value;
			return;

		}
		return Schema::setRef(field, value);
	}

	Schema* createInstance(std::type_index type) {
		if (type == typeid(Entity))
		{
			return new Entity();

		} else if (type == typeid(Player))
		{
			return new Player();

		} else if (type == typeid(Bot))
		{
			return new Bot();

		}
		return Schema::createInstance(type);
	}
};


#endif
