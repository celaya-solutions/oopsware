"""Tiny module for decompiler checks."""
GREETING = "hello"
LIMIT = 3


def double(value):
    return value * 2


class Counter:
    def __init__(self, start):
        self.count = start

    def bump(self):
        self.count = self.count + 1
        return self.count
