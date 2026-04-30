import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

const manifestPath = join(rootDir, "public", "manifest.json");
const original = readFileSync(manifestPath, "utf8");

const testKey =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAzEnVSnWS9tPg+cKm4zCO" +
  "tRMM0Gv2oXXlDGAjpqGo6QepHK/oMRgRY10NIOSWuhJ+IZJY8kqMmLFRuIHXRtKS" +
  "od5f3MfKsllK9DZ9xhdeDE0Ia5+hsToO6xNGo2cEp1EHqNDuAAGicYl8RugX1TeM" +
  "mFZ63Kk8bLsAqfqegyKELQadGpHqzVRv7BZsTttr7Dy8wo8IkI3eQNBamUZvFNjx" +
  "P6U+YO4HP/zAgJUBPnUo+6CKoR2xqs1ZqJrHDIxY0RWwRsvc/cA59LIWwMV2t/Ji" +
  "U/LByaPrGi4QOu9El0NN5vBCvsqZ8oyaLBgGv/A5E1QUEkUKb7Q6pwDKgDFrP6Xj" +
  "XQIDAQAB";

const manifest = JSON.parse(original);
manifest.key = testKey;
manifest.name = "Web Page Downloader (test)";

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

try {
  execSync("npx vite build", { stdio: "inherit", cwd: rootDir });

  const zipDir = join(rootDir, "zip");
  const zipTestDir = join(rootDir, "zip_test");
  if (!existsSync(zipTestDir)) mkdirSync(zipTestDir, { recursive: true });

  const zipName = `web-page-downloader${manifest.version}.zip`;
  const zipPath = join(zipDir, zipName);

  if (existsSync(zipPath)) {
    renameSync(zipPath, join(zipTestDir, zipName));
    console.log(`\nTest build: zip_test/${zipName}`);
  } else {
    console.error(`\nExpected zip not found: ${zipPath}`);
    process.exitCode = 1;
  }
} finally {
  writeFileSync(manifestPath, original);
}
