import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./tests/mock-pi-loader.mjs", pathToFileURL("./"));
