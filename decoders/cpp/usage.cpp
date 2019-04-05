#include <stdio.h>
#include "schema.h"

#include "State.hpp"

int main()
{
    const unsigned char encodedState[] = {0, 3, 3, 0, 163, 111, 110, 101, 1, 163, 116, 119, 111, 2, 165, 116, 104, 114, 101, 101, 1, 3, 3, 0, 1, 1, 2, 2, 3, 2, 3, 3, 0, 0, 100, 1, 100, 2, 170, 80, 108, 97, 121, 101, 114, 32, 79, 110, 101, 193, 1, 0, 204, 200, 1, 204, 200, 2, 170, 80, 108, 97, 121, 101, 114, 32, 84, 119, 111, 193, 2, 0, 204, 250, 1, 204, 250, 2, 172, 80, 108, 97, 121, 101, 114, 32, 84, 104, 114, 101, 101, 193, 3, 0, 4, 0, 5, 0};

    State *state = new State();
    state->decode(encodedState, 98);

    std::cout << "state.arrayOfNumbers.size() => " << state->arrayOfNumbers.size() << std::endl;
    std::cout << "state.arrayOfNumbers[0] => " << state->arrayOfNumbers[0] << std::endl;
    std::cout << "state.arrayOfNumbers[1] => " << state->arrayOfNumbers[1] << std::endl;
    std::cout << "state.arrayOfNumbers[2] => " << state->arrayOfNumbers[2] << std::endl;

    std::cout << "state.arrayOfStrings[0] => " << *state->arrayOfStrings[0] << std::endl;
    std::cout << "state.arrayOfStrings[1] => " << *state->arrayOfStrings[1] << std::endl;
    std::cout << "state.arrayOfStrings[2] => " << *state->arrayOfStrings[2] << std::endl;

    std::cout << "state.arrayOfStrings[0] => " << state->arrayOfPlayers[0]->name << std::endl;
    std::cout << "state.arrayOfStrings[1] => " << state->arrayOfPlayers[1]->name << std::endl;
    std::cout << "state.arrayOfStrings[2] => " << state->arrayOfPlayers[2]->name << std::endl;

    return 0;
}
