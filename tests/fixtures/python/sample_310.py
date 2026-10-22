def classify(point):
    match point:
        case (0, 0):
            return "origin"
        case {"x": x, **rest} if x > 0:
            return f"x={x} {rest}"
        case [first, *others]:
            return first, others
        case Point(x=0) | Point(y=0):
            return "axis"
        case str() as text:
            return text
        case _:
            return None
