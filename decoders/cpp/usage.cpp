#include <stdio.h>
#include "schema.h"

#include <vector>
#include <map>
#include <string>

#include <typeinfo>
#include <typeindex>

using namespace colyseus::schema;

struct Player : public Schema
{
  public:
    string name;
    varint_t x;
    varint_t y;

    Player()
    {
        this->_indexes = {{0, "name"}, {1, "x"}, {2, "y"}};
        this->_types = {{0, "string"}, {1, "number"}, {2, "number"}};
    }

  protected:
    string getString(string field)
    {
        if (field == "name")
        {
            return this->name;
        }
        return Schema::getString(field);
    }

    void setString(string field, string value)
    {
        if (field == "name")
        {
            this->name = value;
        }
    }

    varint_t getNumber(string field)
    {
        if (field == "x")
        {
            return this->x;
        }
        else if (field == "y")
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
        }
        else if (field == "y")
        {
            this->y = value;
        }
    }
};

class State : public Schema
{
  public:
    string fieldString;
    varint_t number;
    Player *player = new Player();
    ArraySchema<Player*> arrayOfPlayers;
    MapSchema<Player*> mapOfPlayers;

    State()
    {
        this->_indexes = {{0, "fieldString"}, {1, "number"}, {2, "player"}, {3, "arrayOfPlayers"}, {4, "mapOfPlayers"}};
        this->_types = {{0, "string"}, {1, "number"}, {2, "ref"}, {3, "array"}, {4, "map"}};
        this->_childSchemaTypes = {{2, typeid(Player)}, {3, typeid(Player)}, {4, typeid(Player)}};
    }

  protected:
    string getString(std::string field)
    {
        if (field == "fieldString")
        {
            return this->fieldString;
        }
        return Schema::getString(field);
    }

    void setString(std::string field, std::string value)
    {
        if (field == "fieldString")
        {
            this->fieldString = value;
        }
    }

    float getNumber(std::string field)
    {
        if (field == "number")
        {
            return this->number;
        }
        return Schema::getNumber(field);
    }

    void setNumber(std::string field, float value)
    {
        if (field == "number")
        {
            this->number = value;
        }
    }

    Schema *getRef(string field)
    {
        if (field == "player")
        {
            return this->player;
        }
        else
        {
            return nullptr;
        }
    }

    void setRef(string field, Schema *value)
    {
        if (field == "player")
        {
            this->player = (Player *)value;
        }
    }

    void setMap(string field, MapSchema<char*> pointer)
    {
        if (field == "mapOfPlayers")
        {
            this->mapOfPlayers = *(MapSchema<Player*> *)&pointer;
            
            // this->mapOfPlayers = static_cast<MapSchema<Player*>>(pointer);
        }
    }

    Schema *createInstance(std::type_index type)
    {
        if (type == typeid(Player))
        {
            return new Player();
        }
        else
        {
            return nullptr;
        }
    }
};

int main()
{
    const unsigned char encodedState[] = {0, 171, 72, 101, 108, 108, 111, 32, 119, 111, 114, 108, 100, 1, 204, 200, 2, 0, 173, 74, 97, 107, 101, 32, 66, 97, 100, 108, 97, 110, 100, 115, 1, 100, 2, 100, 193, 4, 1, 163, 111, 110, 101, 0, 175, 80, 108, 97, 121, 101, 114, 32, 105, 110, 32, 97, 32, 109, 97, 112, 1, 80, 2, 90, 193};

    State *state = new State();
    state->decode(encodedState, 65);

    std::cout << "state.fieldString: " << state->fieldString << std::endl;
    std::cout << "state.number: " << state->number << std::endl;
    std::cout << "player.name: " << state->player->name << std::endl;
    std::cout << "player.x: " << state->player->x << std::endl;
    std::cout << "player.y: " << state->player->y << std::endl;
    std::cout << "mapOfPlayers.size(): " << state->mapOfPlayers.size() << std::endl;
    std::cout << "mapOfPlayers.one.name: " << (state->mapOfPlayers["one"]->name) << std::endl;
    std::cout << "mapOfPlayers.one.x: " << (state->mapOfPlayers["one"]->x) << std::endl;
    std::cout << "mapOfPlayers.one.y: " << (state->mapOfPlayers["one"]->y) << std::endl;

    return 0;
}
