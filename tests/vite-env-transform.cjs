/**
 * Custom Jest transformer that replaces Vite's `import.meta.env.*` references
 * with plain string literals before ts-jest processes the file.
 *
 * This avoids needing ESM mode or --experimental-vm-modules for Jest,
 * while keeping the source code using the standard Vite pattern.
 */

const { TsJestTransformer } = require("ts-jest");

const tsJestTransformer = new TsJestTransformer();

const VITE_ENV_REPLACEMENTS = {
  VITE_SERVER_URL: '"https://test-server.example.com"',
  MODE: '"test"',
  PROD: "false",
  DEV: "true",
};

// Pattern: import.meta.env.VITE_SERVER_URL (with optional ?. chaining)
const IMPORT_META_ENV_RE = /import\.meta\.env\.(\w+)(\?\.)?/g;

function replaceImportMetaEnv(source) {
  return source.replace(IMPORT_META_ENV_RE, (_match, key, optional) => {
    const value = VITE_ENV_REPLACEMENTS[key];
    if (value !== undefined) {
      return value;
    }
    // Unknown env var — replace with undefined
    return "undefined";
  });
}

module.exports = {
  process(sourceText, sourcePath, options) {
    // Replace import.meta.env references with literals
    const transformed = replaceImportMetaEnv(sourceText);
    // Delegate to ts-jest for TypeScript compilation
    return tsJestTransformer.process(transformed, sourcePath, options);
  },
};
