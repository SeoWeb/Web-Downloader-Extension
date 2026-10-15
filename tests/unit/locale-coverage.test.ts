/**
 * Locale key coverage checks (task 6.3 / design D13).
 *
 * Fails when:
 * (a) any i18n key used via `t("...")` in src/ is missing from en.json, or
 * (b) any locale file is missing a key that exists in en.json.
 *
 * Missing non-English keys must be backfilled by `scripts/sync-locales.mjs`
 * (English fallback text); missing English keys are a hard error.
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const ROOT = join(__dirname, "..", "..");
const SRC_DIR = join(ROOT, "src");
const LOCALES_DIR = join(ROOT, "src", "i18n", "locales");

/**
 * Dead-code directories that still contain `t()` calls but are not part of
 * the shipped UI. Keep this list simple — it only exists so removed code
 * does not block the check.
 */
const EXCLUDED_DIRS = [
  join(SRC_DIR, "components", "popup"),
  join(SRC_DIR, "components", "sidepanel"),
  join(SRC_DIR, "components", "ui"),
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function* walk(dir: string): Generator<string> {
  if (EXCLUDED_DIRS.includes(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      yield* walk(full);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      yield full;
    }
  }
}

/**
 * Extract static `t("key")` / `t('key')` usages from source text.
 * Dynamic keys (template literals with `${...}`) are ignored — their static
 * base keys must exist in en.json for i18next to resolve them.
 */
export function extractI18nKeys(source: string): string[] {
  const keys: string[] = [];
  const pattern = /\bt\(\s*["']([^"'\n`]+)["']\s*[,)]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    keys.push(match[1]);
  }
  return keys;
}

type FlatMap = Map<string, string>;

function flatten(obj: any, prefix = "", out: FlatMap = new Map()): FlatMap {
  for (const [key, value] of Object.entries(obj ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object") {
      flatten(value, path, out);
    } else {
      out.set(path, String(value));
    }
  }
  return out;
}

function loadLocale(name: string): FlatMap {
  const raw = JSON.parse(readFileSync(join(LOCALES_DIR, name), "utf-8"));
  // Locale files nest their messages under the i18next "translation" namespace.
  return flatten(raw.translation ?? raw);
}

// ---------------------------------------------------------------------------
// Collected data (once per test run)
// ---------------------------------------------------------------------------

const sourceFiles = [...walk(SRC_DIR)];

const usedKeys = new Set<string>();
const keyUsages = new Map<string, string[]>();
for (const file of sourceFiles) {
  const rel = relative(ROOT, file);
  for (const key of extractI18nKeys(readFileSync(file, "utf-8"))) {
    usedKeys.add(key);
    if (!keyUsages.has(key)) keyUsages.set(key, []);
    keyUsages.get(key)!.push(rel);
  }
}

const englishKeys = loadLocale("en.json");

/**
 * i18next stores pluralized strings as `key_one` / `key_other` / …
 * A used key counts as present when the plain key or any plural suffix
 * of it exists.
 */
const PLURAL_SUFFIXES = [
  "zero",
  "one",
  "two",
  "few",
  "many",
  "other",
] as const;

function hasKey(keys: FlatMap, key: string): boolean {
  if (keys.has(key)) return true;
  return PLURAL_SUFFIXES.some((suffix) => keys.has(`${key}_${suffix}`));
}

const otherLocaleFiles = readdirSync(LOCALES_DIR).filter(
  (f) => f.endsWith(".json") && f !== "en.json",
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("locale coverage", () => {
  it("en.json contains every i18n key used in src/", () => {
    const missing = [...usedKeys]
      .filter((key) => !hasKey(englishKeys, key))
      .sort();

    if (missing.length > 0) {
      const details = missing
        .map((key) => `  - ${key} (used in ${(keyUsages.get(key) ?? []).join(", ")})`)
        .join("\n");
      throw new Error(
        `Missing keys in src/i18n/locales/en.json:\n${details}\n` +
          `Dynamic keys (template literals) are not scanned — their static ` +
          `prefixes must exist in en.json.`,
      );
    }
  });

  it("en.json is not empty", () => {
    expect(englishKeys.size).toBeGreaterThan(0);
  });

  it.each(otherLocaleFiles)("%s contains every key from en.json", (file) => {
    const localeKeys = loadLocale(file);
    const missing = [...englishKeys.keys()]
      .filter((key) => !localeKeys.has(key))
      .sort();

    if (missing.length > 0) {
      throw new Error(
        `${file} is missing ${missing.length} key(s) present in en.json ` +
          `(run \`node scripts/sync-locales.mjs\` to backfill):\n` +
          missing.map((key) => `  - ${key}`).join("\n"),
      );
    }
  });
});
