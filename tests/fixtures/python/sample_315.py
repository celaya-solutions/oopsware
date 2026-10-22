lazy import json
lazy from os import path


def use():
    return json.dumps(path.sep)
