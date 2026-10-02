import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import fs from "node:fs";

const CLIENT_ONLY_MODULES = [
  "react-dom",
  "@tanstack/react-query",
  "@dnd-kit/core",
  "@dnd-kit/sortable",
  "@dnd-kit/utilities",
  "react-hook-form",
  "@hookform/resolvers",
  "next-themes",
  "cmdk",
  "@radix-ui/react-slot",
  "@base-ui/react",
];

function hasUseClientDirective(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    return /^\s*"use client"/m.test(content);
  } catch {
    return false;
  }
}

const noClientImportRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "ban client-only imports from files without 'use client' directive",
    },
    messages: {
      noClientImport:
        "'{{module}}' is a client-only module but this file does not have a \"use client\" directive. Either add \"use client\" at the top or move the import.",
    },
    schema: [],
  },
  create(context) {
    const filePath = context.filename;
    if (hasUseClientDirective(filePath)) return {};
    return {
      ImportDeclaration(node) {
        const source = node.source.value;
        const baseModule = source.split("/").slice(0, 2).join("/");
        if (
          CLIENT_ONLY_MODULES.includes(source) ||
          CLIENT_ONLY_MODULES.includes(baseModule)
        ) {
          context.report({
            node,
            messageId: "noClientImport",
            data: { module: source },
          });
        }
      },
    };
  },
};

const noClientImportsPlugin = {
  rules: { noClientImport: noClientImportRule },
};

const eslintConfig = defineConfig([
  {
    files: ["**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}", "**/test/**"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
      react,
      "react-hooks": reactHooks,
      "no-client-imports-in-server": noClientImportsPlugin,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      ...react.configs.recommended.rules,
      ...react.configs["jsx-runtime"].rules,
      ...reactHooks.configs.recommended.rules,
      "no-client-imports-in-server/noClientImport": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "react/prop-types": "off",
      "react/no-children-prop": "off",
      "react-hooks/purity": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/refs": "off",
      "react-hooks/incompatible-library": "off",
      "react-hooks/error-boundaries": "off",
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "@heroicons/react", message: "Use lucide-react instead." },
            { name: "react-icons", message: "Use lucide-react instead." },
            { name: "@fortawesome/react-fontawesome", message: "Use lucide-react instead." },
            { name: "@fortawesome/free-solid-svg-icons", message: "Use lucide-react instead." },
            { name: "@fortawesome/free-regular-svg-icons", message: "Use lucide-react instead." },
            { name: "@fortawesome/free-brands-svg-icons", message: "Use lucide-react instead." },
          ],
          patterns: [
            { group: ["@heroicons/**"], message: "Use lucide-react instead." },
            { group: ["react-icons/**"], message: "Use lucide-react instead." },
            { group: ["@fortawesome/**"], message: "Use lucide-react instead." },
          ],
        },
      ],
    },
    settings: {
      react: { version: "detect" },
    },
  },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
]);

export default eslintConfig;
