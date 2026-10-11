import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import coreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";
import globals from "globals";
import tseslint from "typescript-eslint";

const webFiles = ["apps/web/**/*.{js,jsx,mjs,ts,tsx}"];
const nonWebTypeScriptFiles = ["packages/**/*.ts", "workers/**/*.ts", "scripts/**/*.ts"];
const unusedVarsRule = [
  "error",
  {
    argsIgnorePattern: "^_",
    varsIgnorePattern: "^_",
    caughtErrorsIgnorePattern: "^_",
  },
];

const scopeNextConfigs = (configs) =>
  configs.map((config) => {
    if (Object.keys(config).length === 1 && "ignores" in config) {
      return config;
    }

    return {
      ...config,
      files: config.files ? config.files.map((pattern) => `apps/web/${pattern}`) : webFiles,
      settings: {
        ...config.settings,
        next: {
          ...config.settings?.next,
          rootDir: "apps/web/",
        },
      },
    };
  });

export default defineConfig([
  globalIgnores([
    "**/node_modules/**",
    "**/.next/**",
    "**/out/**",
    "**/build/**",
    "**/dist/**",
    "**/coverage/**",
    "**/lib/generated/**",
    "**/next-env.d.ts",
    "**/test-results/**",
    "**/playwright-report/**",
    "apps/android/**",
  ]),
  js.configs.recommended,
  {
    files: ["packages/**/*", "workers/**/*", "scripts/**/*", "*.mjs"],
    languageOptions: {
      globals: globals.node,
    },
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: nonWebTypeScriptFiles,
  })),
  ...scopeNextConfigs(coreWebVitals),
  ...scopeNextConfigs(nextTypeScript),
  {
    files: nonWebTypeScriptFiles,
    rules: {
      "@typescript-eslint/no-unused-vars": unusedVarsRule,
    },
  },
  {
    files: ["apps/web/**/*.ts", "apps/web/**/*.tsx"],
    rules: {
      "@typescript-eslint/no-unused-vars": unusedVarsRule,
    },
  },
]);
