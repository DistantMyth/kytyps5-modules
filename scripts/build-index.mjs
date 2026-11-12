import { readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CATEGORIES,
  CATEGORY_SINGULAR,
  STRICT_FILENAME_REGEX,
  FILENAME_REGEX,
  validateModuleJson,
} from "./lib/schema.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

async function run() {
  // Read existing index to check whether content changed
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
      const rawDiskBytes = await readFile(fullPath);

      // Normalize line endings to LF (\n) for consistent platform-independent hashing and sizing
      const normalizedText = rawDiskBytes.toString("utf8").replace(/\r\n/g, "\n");
      const normalizedBytes = Buffer.from(normalizedText, "utf8");

      let parsed;
      try {
        parsed = JSON.parse(normalizedText);
      } catch (err) {
        console.error(`[ERROR] Malformed JSON in ${cat}/json/${entry.name}: ${err.message}`);
        throw err;
      }

      // Conformance validate against schema
      validateModuleJson(parsed, ppsa, verScore, { isStrict: true, category: cat });

      const sha256 = createHash("sha256").update(normalizedBytes).digest("hex");
      const relativePath = `${cat}/json/${entry.name}`;
      const singularName = CATEGORY_SINGULAR[cat] || cat;

      const title = String(
        parsed.name ||
        parsed.title ||
        `${gameName.replace(/_/g, " ")} (${singularName})`
      ).trim();

      const description = typeof parsed.description === "string" ? parsed.description.trim() : "";
      const author =
        typeof parsed.author === "string" && parsed.author.trim()
          ? parsed.author.trim()
          : typeof parsed.creator === "string" && parsed.creator.trim()
            ? parsed.creator.trim()
            : "Community";

      const moduleEntry = {
        id: ppsa,
        version: verScore, // normalized with underscores (e.g. 01_007_000)
        gameName: gameName.replace(/_/g, " "),
        index: seq ? parseInt(seq, 10) : 1,
        title,
        description,
        author,
        path: relativePath,
        sha256,
        size: normalizedBytes.byteLength,
      };

      if (!catalog[cat][ppsa]) {
        catalog[cat][ppsa] = [];
      }
      catalog[cat][ppsa].push(moduleEntry);
      totalFiles++;
    }

    // Deterministically sort entries within each PPSA
    for (const ppsa of Object.keys(catalog[cat])) {
      catalog[cat][ppsa].sort((a, b) => {
        const verCmp = a.version.localeCompare(b.version, "en", { numeric: true });
        if (verCmp !== 0) return verCmp;
        if (a.index !== b.index) return a.index - b.index;
        return a.path.localeCompare(b.path, "en");
      });
    }

    // Deterministically sort PPSA dictionary keys alphabetically
    const sortedCat = {};
    for (const ppsa of Object.keys(catalog[cat]).sort()) {
      sortedCat[ppsa] = catalog[cat][ppsa];
    }
    catalog[cat] = sortedCat;
  }

  // Check if catalog data changed compared to existing index
  const catalogHash = createHash("sha256").update(JSON.stringify(catalog)).digest("hex");
  const existingHash = existingIndex?.catalogHash || null;

  const updatedAt =
    existingIndex && existingHash === catalogHash
      ? existingIndex.updatedAt
      : new Date().toISOString();

  const finalIndex = {
    version: 1,
    catalogHash,
    updatedAt,
    ...catalog,
  };

  await writeFile(path.join(root, "index.json"), JSON.stringify(finalIndex, null, 2) + "\n", "utf8");
  await writeFile(path.join(root, "index.min.json"), JSON.stringify(finalIndex) + "\n", "utf8");

  console.log(`[INFO] Successfully indexed ${totalFiles} modules across ${CATEGORIES.length} categories (hash: ${catalogHash.slice(0, 12)}).`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
