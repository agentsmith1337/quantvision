// Copy Monaco's prebuilt files into public/monaco so the editor loads from the local
// app instead of a CDN (QuantVision runs offline-friendly on the user's machine).
// Skipped when the copy already matches the installed monaco-editor version.
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "node_modules/monaco-editor/package.json"), "utf8"));
const dest = join(root, "public/monaco");
const stamp = join(dest, "VERSION");

if (existsSync(stamp) && readFileSync(stamp, "utf8").trim() === pkg.version) process.exit(0);

rmSync(dest, { recursive: true, force: true });
cpSync(join(root, "node_modules/monaco-editor/min/vs"), join(dest, "vs"), { recursive: true });
writeFileSync(stamp, pkg.version);
console.log(`copy-monaco: monaco-editor ${pkg.version} -> public/monaco`);
