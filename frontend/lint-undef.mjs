export default [{
  files: ["src/**/*.{js,jsx}"],
  languageOptions: {
    ecmaVersion: "latest", sourceType: "module",
    parserOptions: { ecmaFeatures: { jsx: true } },
    globals: {
      window: "readonly", document: "readonly", console: "readonly", fetch: "readonly",
      localStorage: "readonly", setTimeout: "readonly", clearTimeout: "readonly",
      setInterval: "readonly", clearInterval: "readonly", requestAnimationFrame: "readonly",
      cancelAnimationFrame: "readonly", ResizeObserver: "readonly", Image: "readonly",
      performance: "readonly", CustomEvent: "readonly", navigator: "readonly",
      getComputedStyle: "readonly", Map: "readonly", Set: "readonly", Promise: "readonly",
      Math: "readonly", JSON: "readonly", Number: "readonly", String: "readonly",
      Array: "readonly", Object: "readonly", Date: "readonly", Infinity: "readonly",
      encodeURIComponent: "readonly", React: "readonly", process: "readonly", Error: "readonly",
      Boolean: "readonly", FormData: "readonly", URL: "readonly", isNaN: "readonly",
      parseInt: "readonly", parseFloat: "readonly", Symbol: "readonly", undefined: "readonly",
    },
  },
  rules: { "no-undef": "error" },
}];
