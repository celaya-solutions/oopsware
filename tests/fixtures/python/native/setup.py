from setuptools import Extension, setup

setup(ext_modules=[Extension("oopsnative._speed", ["src/speed.c"])], packages=["oopsnative"], package_dir={"": "src"})
