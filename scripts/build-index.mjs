import { readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  CATEGORIES,
  FILENAME_REGEX,
  STRICT_FILENAME_REGEX,
  normalizeVersionToDisplay,
} from "./lib/schema.mjs";

async function run() {
  const root = process.cwd();
  const index = {
    version: 1,
    updatedAt: new Date().toISOString(),
    patches: {},
    cheats: {},
    configs: {},
  };

  let totalFiles = 0;

  for (const cat of CATEGORIES) {
    const dir = path.join(root, cat, "json");
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;

      let match = entry.name.match(STRICT_FILENAME_REGEX);
      if (!match) {
        match = entry.name.match(FILENAME_REGEX);
      }

      if (!match) {
        console.warn(`[WARN] Skipping non-conforming file: ${cat}/json/${entry.name}`);
        continue;
      }

      const [, ppsa, verScore, gameName, seq] = match;
      const fullPath = path.join(dir, entry.name);
      const rawBytes = await readFile(fullPath);
      let parsed;
      try {
        parsed = JSON.parse(rawBytes.toString("utf8"));
      } catch (err) {
        console.error(`[ERROR] Malformed JSON in ${cat}/json/${entry.name}: ${err.message}`);
        throw err;
      }

      const sha256 = createHash("sha256").update(rawBytes).digest("hex");
      const relativePath = `${cat}/json/${entry.name}`;

      const title =
        parsed.name ||
        parsed.title ||
        `${gameName.replace(/_/g, " ")} (${cat.slice(0, -1)})`;
      const description = parsed.description || "";
      const author = parsed.author || parsed.creator || "Community";

      const moduleEntry = {
        id: ppsa,
        version: normalizeVersionToDisplay(verScore),
        gameName: gameName.replace(/_/g, " "),
        index: seq ? parseInt(seq, 10) : 1,
        title,
        description,
        author,
        path: relativePath,
        sha256,
        size: rawBytes.byteLength,
      };

      if (!index[cat][ppsa]) {
        index[cat][ppsa] = [];
      }
      index[cat][ppsa].push(moduleEntry);
      totalFiles++;
    }

    // Sort entries for each PPSA by version and sequence index
    for (const ppsa of Object.keys(index[cat])) {
      index[cat][ppsa].sort((a, b) => {
        if (a.version !== b.version) return a.version.localeCompare(b.version);
        return a.index - b.index;
      });
    }
  }

  await writeFile(path.join(root, "index.json"), JSON.stringify(index, null, 2) + "\n");
  await writeFile(path.join(root, "index.min.json"), JSON.stringify(index) + "\n");

  console.log(`[INFO] Successfully indexed ${totalFiles} modules across ${CATEGORIES.length} categories.`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
