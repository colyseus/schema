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

    static const std::vector<std::string> _order;
    static const std::map<int, std::string> _indexes;
};
const std::vector<std::string> Player::_order = {"name", "x", "y"};
const std::map<int, std::string> Player::_indexes = {{0, "name"}, {1, "x"}, {2, "y"}};

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

    static const std::vector<std::string> _order;
    static const std::map<int, std::string> _indexes;
};

const std::vector<std::string> State::_order = {"fieldString", "number", "player", "arrayOfPlayers", "mapOfPlayers"};
const std::map<int, std::string> State::_indexes = { {0, "fieldString"}, {1, "number"}, {2, "player"}, {3, "arrayOfPlayers"}, {4, "mapOfPlayers"} };

int main () {
    const int encodedState[2] = {1, 50};

    State* state = new State();
    state->decode(encodedState, 2);

    printf("Hello world!");
    return 0;
}
