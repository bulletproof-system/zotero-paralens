/** Optional test-only shim to extract text with Zotero's bundled PDF.js in Node. */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const [pdfjsModule, pdfPath] = process.argv.slice(2);
if (!pdfjsModule || !pdfPath)
  throw new Error("Usage: node scripts/zotero-pdfjs-text.mjs <pdf.mjs> <pdf>");

// Zotero runs PDF.js inside Gecko; Node 22 lacks these browser/newer-runtime APIs.
Uint8Array.prototype.toHex ??= function () {
  return Buffer.from(this).toString("hex");
};
Promise.try ??= (fn, ...args) => Promise.resolve().then(() => fn(...args));
Math.sumPrecise ??= (values) => Array.from(values).reduce((a, b) => a + b, 0);
globalThis.DOMMatrix ??= class DOMMatrix {
  constructor(values) {
    this.values = values;
  }
};
globalThis.ImageData ??= class ImageData {};
globalThis.Path2D ??= class Path2D {};

const { getDocument } = await import(pathToFileURL(resolve(pdfjsModule)).href);
const data = new Uint8Array(readFileSync(pdfPath));
const document = await getDocument({
  data,
  useSystemFonts: true,
  disableFontFace: true,
}).promise;
const texts = [];
for (let index = 1; index <= document.numPages; index++) {
  const page = await document.getPage(index);
  texts.push(
    (await page.getTextContent()).items.map((item) => item.str).join(""),
  );
}
console.log(
  JSON.stringify({ pages: document.numPages, text: texts.join("\n") }),
);
process.exit(0);
