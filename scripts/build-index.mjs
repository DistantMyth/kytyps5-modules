import { readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  CATEGORIES,
  CATEGORY_SINGULAR,
  FILENAME_REGEX,
  STRICT_FILENAME_REGEX,
  normalizeVersionToDisplay,
} from "./lib/schema.mjs";

async function run() {
  const root = process.cwd();

  // Read existing index to preserve timestamp if content didn't change
  let existingIndex = null;
  try {
    const rawExisting = await readFile(path.join(root, "index.json"), "utf8");
    existingIndex = JSON.parse(rawExisting);
  } catch {
    existingIndex = null;
  }

  const catalog = {
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
      const singularName = CATEGORY_SINGULAR[cat] || cat;

      const title =
        parsed.name ||
        parsed.title ||
        `${gameName.replace(/_/g, " ")} (${singularName})`;
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

      if (!catalog[cat][ppsa]) {
        catalog[cat][ppsa] = [];
      }
      catalog[cat][ppsa].push(moduleEntry);
      totalFiles++;
    }

    // Sort entries for each PPSA by version and sequence index
    for (const ppsa of Object.keys(catalog[cat])) {
      catalog[cat][ppsa].sort((a, b) => {
        if (a.version !== b.version) return a.version.localeCompare(b.version);
        return a.index - b.index;
      });
    }
  }

  // Check if catalog data changed compared to existing index
  const catalogHash = createHash("sha256").update(JSON.stringify(catalog)).digest("hex");
  const existingCatalog = existingIndex
    ? { patches: existingIndex.patches, cheats: existingIndex.cheats, configs: existingIndex.configs }
    : null;
  const existingHash = existingCatalog
    ? createHash("sha256").update(JSON.stringify(existingCatalog)).digest("hex")
    : null;

  const updatedAt =
    existingIndex && existingHash === catalogHash
      ? existingIndex.updatedAt
      : new Date().toISOString();

  const finalIndex = {
    version: 1,
    updatedAt,
    ...catalog,
  };

  await writeFile(path.join(root, "index.json"), JSON.stringify(finalIndex, null, 2) + "\n");
  await writeFile(path.join(root, "index.min.json"), JSON.stringify(finalIndex) + "\n");

  console.log(`[INFO] Successfully indexed ${totalFiles} modules across ${CATEGORIES.length} categories.`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
