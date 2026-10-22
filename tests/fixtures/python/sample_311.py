def grouped():
    try:
        raise ExceptionGroup("many", [ValueError(1), TypeError(2)])
    except* ValueError as values:
        print(values)
    except* TypeError:
        pass
