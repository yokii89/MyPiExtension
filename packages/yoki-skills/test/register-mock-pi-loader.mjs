import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./test/mock-pi-loader.mjs", pathToFileURL("./"));
