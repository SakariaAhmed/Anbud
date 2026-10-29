import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

const __dirname = dirname(fileURLToPath(import.meta.url));

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "next-env.d.ts",
    ],
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  // Layer boundaries: dependencies point from routes and workflows toward
  // domain and persistence code, never back, and browser code never loads
  // server modules.
  {
    files: [
      "components/**/*.ts",
      "components/**/*.tsx",
      "hooks/**/*.ts",
      "hooks/**/*.tsx",
      "lib/client/**/*.ts",
    ],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/lib/server", "@/lib/server/*"],
              allowTypeImports: true,
              message: "Browser code must not import server modules.",
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      "lib/server/repositories/**/*.ts",
      "lib/server/domain/**/*.ts",
      "lib/server/requirements/**/*.ts",
    ],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/lib/server/use-cases/*"],
              message: "Domain and persistence code must not depend on workflows.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["lib/server/repositories/**/*.ts", "lib/server/domain/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/lib/server/use-cases/*"],
              message: "Domain and persistence code must not depend on workflows.",
            },
            {
              group: ["@/lib/server/ai", "@/lib/server/ai/*"],
              message: "Domain and persistence code must not depend on the AI layer.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["**/*.js", "**/*.cjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
];

export default eslintConfig;
