#include <stdio.h>
#include "schema.h"

#include <vector>
#include <map>
#include <string>

struct Player : public Colyseus::Schema {
    std::string name;
    int x;
    int y;

    template <typename T>
    T &operator[](const std::string &key)
    {
        if (key == "name") {
            return this->name;

        } else if (key == "x") {
            return this->x;

        } else if (key == "y") {
            return this->y;

        } else {
            throw std::invalid_argument("non-existing propery: " + key);
        }
    };

    static const std::vector<std::string> _fields;
};

const std::vector<std::string> Player::_fields = {"name", "x", "y"};

struct State : public Colyseus::Schema {
    std::string fieldString;
    int number;
    Player* player;
    std::vector<Player*> arrayOfPlayers;
    std::map<std::string, Player*> mapOfPlayers;

    template <typename T>
    T &operator[](const std::string &key)
    {
        if (key == "fieldString") {
            return this->fieldString;

        } else if (key == "number") {
            return this->number;

        } else if (key == "player") {
            return this->player;

        } else if (key == "arrayOfPlayers") {
            return this->arrayOfPlayers;

        } else if (key == "mapOfPlayers") {
            return this->mapOfPlayers;

        } else {
            throw std::invalid_argument("non-existing propery: " + key);
        }
    };

    static const std::vector<std::string> _fields;
};

const std::vector<std::string> State::_fields = { "fieldString", "number", "player", "arrayOfPlayers", "mapOfPlayers"};

int main () {
    State* state = new State();
    printf("Hello world!");
    return 0;
}