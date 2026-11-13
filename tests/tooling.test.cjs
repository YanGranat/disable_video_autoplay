const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ESLint } = require("eslint");

test("lint configuration checks browser and CommonJS code with the complexity limit", async () => {
  const eslint = new ESLint();
  const browser = await eslint.lintText("window.probe = missingBinding;", { filePath: "content_main.js" });
  assert.ok(browser[0].messages.some(message => message.ruleId === "no-undef"));
  const common = await eslint.lintText("const unusedBinding = 1; module.exports = require('node:path');", { filePath: "scripts/probe.cjs" });
  assert.ok(common[0].messages.some(message => message.ruleId === "no-unused-vars"));
  assert.equal(common[0].messages.some(message => message.ruleId === "no-undef"), false);
  const branches = Array.from({ length: 25 }, (_, i) => `if (value === ${i}) return ${i};`).join("\n");
  const complex = await eslint.lintText(`window.probe = function (value) { ${branches} return -1; };`, { filePath: "content_main.js" });
  assert.ok(complex[0].messages.some(message => message.ruleId === "complexity"));
  for (const file of ["dist/main.js", "vendor/domain-parser.js", "node_modules/probe.js", "temporary_files/probe.js"]) {
    assert.equal(await eslint.isPathIgnored(file), true, file);
  }
});
