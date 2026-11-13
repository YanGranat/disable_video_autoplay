const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
  { ignores: ["dist/**", "vendor/**", "node_modules/**", "temporary_files/**", "dev_docs/**"] },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: { sourceType: "script", globals: { ...globals.browser, chrome: "readonly" } },
    rules: { complexity: ["error", 25] },
  },
  {
    files: ["background.js"],
    languageOptions: { globals: globals.serviceworker },
  },
  {
    files: ["**/*.cjs"],
    languageOptions: { sourceType: "commonjs", globals: globals.node },
  },
  {
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", ignoreRestSiblings: true, caughtErrors: "none" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
];
