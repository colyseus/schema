#include <iostream>
#include "schema.h"
#include "PrimitiveTypes.hpp"

int main()
{
    const unsigned char encodedState[] = {0, 128, 1, 255, 2, 0, 128, 3, 255, 255, 4, 0, 0, 0, 128, 5, 255, 255, 255, 255, 6, 0, 0, 0, 0, 0, 0, 0, 128, 7, 255, 255, 255, 255, 255, 255, 31, 0, 8, 255, 255, 127, 255, 9, 255, 255, 255, 255, 255, 255, 239, 127, 10, 208, 128, 11, 204, 255, 12, 209, 0, 128, 13, 205, 255, 255, 14, 210, 0, 0, 0, 128, 15, 203, 0, 0, 224, 255, 255, 255, 239, 65, 16, 203, 0, 0, 0, 0, 0, 0, 224, 195, 17, 203, 255, 255, 255, 255, 255, 255, 63, 67, 18, 203, 61, 255, 145, 224, 255, 255, 239, 199, 19, 203, 255, 255, 255, 255, 255, 255, 239, 127, 20, 171, 72, 101, 108, 108, 111, 32, 119, 111, 114, 108, 100, 21, 1};

    PrimitiveTypes *p = new PrimitiveTypes();
    std::cerr << "============ about to decode\n";
    p->decode(encodedState, sizeof(encodedState) / sizeof(unsigned char));
    std::cerr << "============ decoded ================================================================ \n";

    printf("p.int8 %i\n", p->int8);
    printf("p.uint8 %i\n", p->uint8);
    printf("p.int16 %i\n", p->int16);
    printf("p.uint16 %i\n", p->uint16);
    printf("p.int32 %i\n", p->int32);
    printf("p.uint32 %i\n", p->uint32);
    printf("p.int64 %lli\n", p->int64);
    printf("p.uint64 %llu\n", p->uint64);
    printf("p.float32 %f\n", p->float32);
    printf("p.float64 %f\n", p->float64);
    printf("p.varint_int8 %f\n", p->varint_int8);
    printf("p.varint_uint8 %f\n", p->varint_uint8);
    printf("p.varint_int16 %f\n", p->varint_int16);
    printf("p.varint_uint16 %f\n", p->varint_uint16);
    printf("p.varint_int32 %f\n", p->varint_int32);
    printf("p.varint_uint32 %f\n", p->varint_uint32);
    printf("p.varint_int64 %f\n", p->varint_int64);
    printf("p.varint_uint64 %f\n", p->varint_uint64);
    printf("p.varint_float32 %f\n", p->varint_float32);
    printf("p.varint_float64 %f\n", p->varint_float64);
    printf("p.str %s\n", p->str.c_str());
    printf("p.boolean %i\n", p->boolean);

    std::cout << std::endl;

    delete p;
    return 0;
}
