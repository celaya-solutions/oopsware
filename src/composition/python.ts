import { PythonService } from "../application/python/PythonService.js";
import { PythonProvider } from "../python/PythonProvider.js";

/** In-process .pyc, wheel and zip application reading; source goes to an installed interpreter's ast module. */
export const createPythonService = (): PythonService =>
  new PythonService(new PythonProvider());
