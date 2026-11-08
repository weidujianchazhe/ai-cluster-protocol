import { buildTools } from "../lib/tools.js";
const fake = new Proxy({}, {
  get: (_t, prop) => {
    if (prop === "config") return { toolPrefix: "" };
    return () => {
      if (prop === "taskNext") return { ok: true, action: "task_next", result: { ok: true, role: "CODE", ready: [], task: null, weird: NaN, missing: undefined }, persistence: { incomplete: false } };
      return { ok: true };
    };
  },
});
const tools = buildTools(fake);
const t = tools.find((x) => x.name === "task_next");
const out = await t.execute({ role: "CODE" }, {});
console.log("raw type:", typeof out);
console.log("json:", JSON.stringify(out));
console.log("has undefined:", JSON.stringify(out) === undefined);
