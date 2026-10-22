/* Compile only. The verifier never runs this executable. */
static int inline_candidate(int value) { return value * 7 + 3; }
int inline_wrapper(int value) { return inline_candidate(value) + 13; }
int main(int argc, char **argv) {
  (void)argv;
  return inline_wrapper(argc);
}
