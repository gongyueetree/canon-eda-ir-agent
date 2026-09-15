import { copyFileSync, mkdirSync } from "node:fs";
mkdirSync("public", { recursive: true });
copyFileSync(
  "node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs",
  "public/pdf.worker.min.mjs",
);

mkdirSync("public/occt", {recursive:true});
for(const file of ["occt-import-js.js","occt-import-js.wasm","license.occt-import-js.txt","license.occt.txt"])copyFileSync(`node_modules/occt-import-js/dist/${file}`,`public/occt/${file}`);
