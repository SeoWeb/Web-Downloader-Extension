#!/usr/bin/env node
/**
 * Locale sync script (task 6.2 / design D13).
 *
 * `src/i18n/locales/en.json` is the single source of truth. For every other
 * locale file in `src/i18n/locales/`, this script:
 *   - adds any key that is missing (deep-merged, English fallback text),
 *   - preserves existing translations,
 *   - preserves the target file's key order as much as possible (new keys
 *     are appended in en.json's order within their section),
 *   - writes back with stable 2-space JSON formatting + trailing newline.
 *
 * Usage: node scripts/sync-locales.mjs
 */

import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCALES_DIR = join(ROOT, "src", "i18n", "locales");

/** Deep-merge `source` into `target` (mutates and returns `target`). */
function deepMerge(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      target[key] !== null &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      deepMerge(target[key], value);
    } else if (!(key in target)) {
      target[key] = value;
    }
  }
  return target;
}

const en = JSON.parse(readFileSync(join(LOCALES_DIR, "en.json"), "utf-8"));

const localeFiles = readdirSync(LOCALES_DIR).filter(
  (f) => f.endsWith(".json") && f !== "en.json",
);

let totalAdded = 0;
const perLocale = [];

for (const file of localeFiles) {
  const path = join(LOCALES_DIR, file);
  const raw = readFileSync(path, "utf-8");
  const locale = JSON.parse(raw);
  const messages = locale.translation ?? locale;

  const before = countKeys(messages);
  deepMerge(messages, en.translation ?? en);
  const added = countKeys(messages) - before;
  totalAdded += added;
  perLocale.push(`${file}: +${added}`);

  writeFileSync(path, JSON.stringify(locale, null, 2) + "\n");
}

function countKeys(obj) {
  let count = 0;
  for (const value of Object.values(obj ?? {})) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      count += countKeys(value);
    } else {
      count += 1;
    }
  }
  return count;
}

console.log(`Synced ${localeFiles.length} locale file(s) against en.json.`);
for (const line of perLocale) console.log(`  ${line}`);
console.log(`Total keys added: ${totalAdded}`);
