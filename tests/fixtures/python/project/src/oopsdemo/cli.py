import importlib
import sys


def main(argv=None):
    plugin = importlib.import_module("oopsdemo.plugins")
    return plugin.Basic().run(argv or sys.argv[1:])
