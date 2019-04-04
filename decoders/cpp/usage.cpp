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
        this->_order = {"name", "x", "y"};
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
        else
        {
            return "";
        }
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
        else
        {
            return 0;
        }
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
    std::vector<Player *> arrayOfPlayers;
    std::map<string, Player *> mapOfPlayers;

    State()
    {
        this->_order = {"fieldString", "number", "player", "arrayOfPlayers", "mapOfPlayers"};
        this->_indexes = {{0, "fieldString"}, {1, "number"}, {2, "player"}, {3, "arrayOfPlayers"}, {4, "mapOfPlayers"}};

        this->_types = {{0, "string"}, {1, "number"}, {2, "ref"}, {3, "array"}, {4, "map"}};
        this->_childTypes = {{2, typeid(Player)}, {3, typeid(Player)}, {4, typeid(Player)}};
    }

  protected:
    string getString(string field)
    {
        if (field == "fieldString")
        {
            return this->fieldString;
        }
        else
        {
            return "";
        }
    }

    void setString(string field, string value)
    {
        if (field == "fieldString")
        {
            this->fieldString = value;
        }
    }

    float getNumber(string field)
    {
        if (field == "number")
        {
            return this->number;
        }
        else
        {
            return 0;
        }
    }

    void setNumber(string field, float value)
    {
        if (field == "number")
        {
            this->number = value;
        }
    }

    Schema *getSchema(string field)
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

    void setSchema(string field, Schema *value)
    {
        if (field == "player")
        {
            this->player = (Player *)value;
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
    const unsigned char encodedState[] = {0, 171, 72, 101, 108, 108, 111, 32, 119, 111, 114, 108, 100, 1, 204, 200, 2, 0, 173, 74, 97, 107, 101, 32, 66, 97, 100, 108, 97, 110, 100, 115, 1, 100, 2, 100, 193};

    State *state = new State();
    state->decode(encodedState, 37);

    std::cout << "state.fieldString: " << state->fieldString << std::endl;
    std::cout << "state.number: " << state->number << std::endl;
    std::cout << "player.name: " << state->player->name << std::endl;
    std::cout << "player.x: " << state->player->x << std::endl;
    std::cout << "player.y: " << state->player->y << std::endl;

    return 0;
}
