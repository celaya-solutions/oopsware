type Pair[T] = tuple[T, T]


def first[T: (int, str), *Ts, **P](items: list[T]) -> T:
    return items[0]


class Box[T]:
    def get(self) -> T: ...
