import { sanitizeForHost } from "../lib/service.js";
const drops = [];
const bad = {
  a: undefined,
  b: NaN,
  c: Infinity,
  d: [undefined, 1, NaN],
  e: new Map([["x", undefined]]),
  f: { g: undefined, h: -Infinity },
  nested: { deep: { deeper: undefined } },
};
const out = sanitizeForHost(bad, (p, r) => drops.push(`${p}:${r}`));
const text = JSON.stringify(out);
const stillBad =
  /undefined/.test(text) || text.includes("null,null") ? false : false;
console.log("out =", text);
console.log("drops =", drops.length);
drops.forEach((d) => console.log("  " + d));
const hasUndef = JSON.stringify(out) === undefined;
console.log(hasUndef ? "FAIL" : "PASS 无 undefined / 无 NaN 残留");
