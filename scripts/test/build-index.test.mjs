import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");

describe("Index Integrity & Build Tests", () => {
  test("index.json and index.min.json exist and match schema", async () => {
    const rawIndex = await readFile(path.join(root, "index.json"), "utf8");
    const rawMin = await readFile(path.join(root, "index.min.json"), "utf8");

    const index = JSON.parse(rawIndex);
    const indexMin = JSON.parse(rawMin);

    assert.equal(index.version, 1);
    assert.equal(typeof index.catalogHash, "string");
    assert.equal(index.catalogHash.length, 64);
    assert.equal(typeof index.updatedAt, "string");
    assert.ok(index.patches);
    assert.ok(index.cheats);
    assert.ok(index.configs);

    // Assert minified content equals formatted content
    assert.equal(index.catalogHash, indexMin.catalogHash);
    assert.equal(index.updatedAt, indexMin.updatedAt);
    assert.deepEqual(index.patches, indexMin.patches);
  });

  test("PPSA keys in index.json are sorted alphabetically", async () => {
    const rawIndex = await readFile(path.join(root, "index.json"), "utf8");
    const index = JSON.parse(rawIndex);

    for (const cat of ["patches", "cheats", "configs"]) {
      const keys = Object.keys(index[cat]);
      const sortedKeys = [...keys].sort();
      assert.deepEqual(keys, sortedKeys);
    }
  });

  test("all module entries in index have positive size and valid 64-char sha256", async () => {
    const rawIndex = await readFile(path.join(root, "index.json"), "utf8");
    const index = JSON.parse(rawIndex);

    for (const cat of ["patches", "cheats", "configs"]) {
      for (const [ppsa, list] of Object.entries(index[cat])) {
        assert.ok(Array.isArray(list));
        for (const entry of list) {
          assert.equal(entry.id, ppsa);
          assert.match(entry.version, /^\d{2}_\d{3}_\d{3}$/);
          assert.match(entry.sha256, /^[0-9a-f]{64}$/);
          assert.ok(entry.size > 0);
          assert.ok(entry.path.startsWith(`${cat}/json/`));
        }
      }
    }
  });
});
