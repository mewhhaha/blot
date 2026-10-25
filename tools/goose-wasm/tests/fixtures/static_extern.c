#include <stdint.h>

_Static_assert(sizeof(void *) == 8, "Goose externs use the LP64 data model");

int64_t c_add(int64_t a, int64_t b) {
    return a + b;
}
