#include <iostream>
#include "schema.h"
#include "ChildSchemaTypes.hpp"

int main()
{
    const unsigned char encodedState[] = {0, 0, 205, 244, 1, 1, 205, 32, 3, 193, 1, 0, 204, 200, 1, 205, 44, 1, 193};

    ChildSchemaTypes *p = new ChildSchemaTypes();
    std::cerr << "============ about to decode\n";
    p->decode(encodedState, sizeof(encodedState) / sizeof(unsigned char));
    std::cerr << "============ decoded ================================================================ \n";

    std::cout << "state.child.x = " << p->child->x << std::endl;
    std::cout << "state.child.y = " << p->child->y << std::endl;

    std::cout << "state.secondChild.x = " << p->secondChild->x << std::endl;
    std::cout << "state.secondChild.y = " << p->secondChild->y << std::endl;

    std::cout << std::endl;

    delete p;
    return 0;
}
