#include <iostream>
#include "schema.h"
#include "InheritedTypes.hpp"

int main()
{
    // const unsigned char encodedState[] = { 0, 0, 205, 244, 1, 1, 205, 32, 3, 193, 1, 0, 204, 200, 1, 205, 44, 1, 2, 166, 80, 108, 97, 121, 101, 114, 193, 2, 0, 100, 1, 204, 150, 2, 163, 66, 111, 116, 3, 204, 200, 193, 3, 213, 2, 3, 100, 193 };
    const unsigned char encodedState[] = { 0, 0, 205, 244, 1, 1, 205, 32, 3, 193, 1, 0, 204, 200, 1, 205, 44, 1, 2, 166, 80, 108, 97, 121, 101, 114, 193, 2, 0, 100, 1, 204, 150, 2, 163, 66, 111, 116, 3, 204, 200, 193 };

    InheritedTypes *p = new InheritedTypes();
    std::cerr << "============ about to decode\n";
    p->decode(encodedState, sizeof(encodedState) / sizeof(unsigned char));
    std::cerr << "============ decoded ================================================================ \n";

    std::cout << "state.entity.x = " << p->entity->x << std::endl;
    std::cout << "state.entity.y = " << p->entity->y << std::endl;
    std::cout << std::endl;

    std::cout << "state.player.name = " << p->player->name << std::endl;
    std::cout << "state.player.x = " << p->player->x << std::endl;
    std::cout << "state.player.y = " << p->player->y << std::endl;
    std::cout << std::endl;

    std::cout << "state.bot.name = " << p->bot->name << std::endl;
    std::cout << "state.bot.x = " << p->bot->x << std::endl;
    std::cout << "state.bot.y = " << p->bot->y << std::endl;
    std::cout << "state.bot.power = " << p->bot->power << std::endl;
    std::cout << std::endl;

    // std::cout << "state.any.power = " << p->any->power << std::endl;

    delete p;
    return 0;
}
