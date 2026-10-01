// Workaround for a Next.js static-export bug on Windows.
//
// Segment prefetch payloads should be written as flat files named by joining the
// segment path with dots (e.g. out/trade/__next.trade.__PAGE__.txt), which is the
// URL the client router requests. On Windows the exporter only replaces "/" and
// not "\", so it writes nested files instead (out/trade/__next.trade/__PAGE__.txt)
// and client-side navigation gets a 404. This flattens them after `next build`.
import { readdirSync, renameSync, rmdirSync, statSync } from "node:fs";
import { join } from "node:path";

const OUT = new URL("../out", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function flatten(segmentDir, prefix, destDir) {
  for (const name of readdirSync(segmentDir)) {
    const src = join(segmentDir, name);
    if (statSync(src).isDirectory()) {
      flatten(src, `${prefix}.${name}`, destDir);
      rmdirSync(src);
    } else {
      renameSync(src, join(destDir, `${prefix}.${name}`));
    }
  }
}

let moved = 0;
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (!statSync(path).isDirectory()) continue;
    if (name.startsWith("__next.")) {
      flatten(path, name, dir);
      rmdirSync(path);
      moved++;
    } else if (name !== "_next") {
      walk(path);
    }
  }
}

walk(OUT);
if (moved) console.log(`fix-export-segments: flattened ${moved} segment folder(s)`);
