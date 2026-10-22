#define PY_SSIZE_T_CLEAN
#include <Python.h>

static PyObject *add(PyObject *self, PyObject *args) {
    long a, b;
    if (!PyArg_ParseTuple(args, "ll", &a, &b)) return NULL;
    return PyLong_FromLong(a + b);
}

static PyMethodDef methods[] = {{"add", add, METH_VARARGS, "Add two integers."}, {NULL, NULL, 0, NULL}};
static struct PyModuleDef module = {PyModuleDef_HEAD_INIT, "_speed", NULL, -1, methods};

PyMODINIT_FUNC PyInit__speed(void) { return PyModule_Create(&module); }
