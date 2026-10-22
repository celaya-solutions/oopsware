#include <stdio.h>

__attribute__((noinline, used)) int parse_header(int value) { return value * 17 + 37; }
__attribute__((noinline, used)) int check_length(int value) { return value >= 0 && value <= 31; }
__attribute__((noinline, used)) int same_helper(int value) { return (value ^ 0x51) + 9; }
__attribute__((noinline, used)) int duplicate_a(int value) { return value * 5 + 11; }
__attribute__((noinline, used)) int duplicate_b(int value) { return value * 5 + 11; }
__attribute__((noinline, used)) int removed_helper(int value) { return value * 19 - 43; }
int main(int argc, char **argv) {
  (void)argv;
  printf("rea fixture before: %d\n", parse_header(argc) + check_length(argc) + same_helper(argc) + duplicate_a(argc) + duplicate_b(argc) + removed_helper(argc));
  return 0;
}
