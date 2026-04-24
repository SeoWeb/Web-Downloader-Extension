/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
  moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json"],
  transform: {
    // Custom transform replaces import.meta.env.* with literals, then ts-jest compiles
    "^.+\\.tsx?$": "<rootDir>/tests/vite-env-transform.cjs",
  },
  // Mock chrome.storage.local for extension code
  setupFiles: ["<rootDir>/tests/setup.cjs"],
};
