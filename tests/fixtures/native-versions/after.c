#include <stdio.h>

__attribute__((noinline, used)) int added_helper(int value) { return value * 23 + 59; }
__attribute__((noinline, used)) int same_helper(int value) { return (value ^ 0x51) + 9; }
__attribute__((noinline, used)) int duplicate_b(int value) { return value * 5 + 11; }
__attribute__((noinline, used)) int decode_header(int value) { return value * 17 + 37; }
__attribute__((noinline, used)) int duplicate_a(int value) { return value * 5 + 11; }
__attribute__((noinline, used)) int check_length(int value) { return value >= 0 && value <= 63; }
int main(int argc, char **argv) {
  (void)argv;
  printf("rea fixture after: %d\n", decode_header(argc) + check_length(argc) + same_helper(argc) + duplicate_a(argc) + duplicate_b(argc) + added_helper(argc));
  return 0;
}
