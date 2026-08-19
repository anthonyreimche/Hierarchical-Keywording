// Bundle the extension to a single ESM file (index.js at the repo root, the
// committed bundle the manifest's "main" points to). JSX compiles classic to
// `React.createElement(...)`, resolving to the app's React instance that every
// module pulls from ./runtime — react stays external so a second copy can never
// bundle in (which would break hooks).

import path from "node:path";
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";

const extDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const bundle = await rolldown({
  input: path.join(extDir, "src", "index.tsx"),
  external: ["react", "react-dom", "react/jsx-runtime"],
  transform: {
    jsx: {
      runtime: "classic",
      pragma: "React.createElement",
      pragmaFrag: "React.Fragment",
    },
  },
});
await bundle.write({
  file: path.join(extDir, "index.js"),
  format: "esm",
});
await bundle.close();

console.log("[hierarchical-keywording] built index.js");
