const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const manifest = JSON.parse(read("manifest.json"));

function runScripts(context, files) {
  for (const file of files) vm.runInContext(read(file), context, { filename: file });
}

function contentScripts(world) {
  return manifest.content_scripts.filter((entry) => entry.world === world).flatMap((entry) => entry.js);
}

function uiScripts(basename) {
  return Array.from(read(`${basename}.html`).matchAll(/<script\s+src="([^"]+)"\s*><\/script>/g), (match) => match[1]);
}

module.exports = { runScripts, contentScripts, uiScripts };
