import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  FILENAME_REGEX,
  STRICT_FILENAME_REGEX,
  sanitizeGameName,
  normalizeVersionToFilename,
  normalizeVersionToDisplay,
  validateTitleId,
  getNextModuleFilename,
  validateModuleJson,
  cleanInputString,
} from "../lib/schema.mjs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("Schema & Validation Tests", () => {
  test("STRICT_FILENAME_REGEX matches indexed formats", () => {
    assert.ok(STRICT_FILENAME_REGEX.test("PPSA01325_01_905_000_Astros_Playroom_1.json"));
    assert.ok(STRICT_FILENAME_REGEX.test("PPSA01325_01_905_000_Astros_Playroom_42.json"));
    assert.ok(STRICT_FILENAME_REGEX.test("PPSA28997_01_008_001_God_of_War_Sons_of_Sparta_1.json"));
    assert.ok(STRICT_FILENAME_REGEX.test("PPSA01234_01_000_000_Cyberpunk_2077_1.json"));

    // Invalid cases:
    assert.ok(!STRICT_FILENAME_REGEX.test("PPSA01325_01.905.000_Astros_1.json")); // dots in version
    assert.ok(!STRICT_FILENAME_REGEX.test("ppsa01325_01_905_000_Astros_1.json")); // lowercase ID
    assert.ok(!STRICT_FILENAME_REGEX.test("PPSA01325_01_905_000_1.json")); // missing game name
  });

  test("cleanInputString removes quotes, backticks and trims", () => {
    assert.equal(cleanInputString("`PPSA01325`"), "PPSA01325");
    assert.equal(cleanInputString('"01.905.000"'), "01.905.000");
    assert.equal(cleanInputString("'Astro's Playroom'"), "Astro's Playroom");
  });

  test("sanitizeGameName converts special characters and spaces cleanly", () => {
    assert.equal(sanitizeGameName("Astro's Playroom"), "Astros_Playroom");
    assert.equal(sanitizeGameName("God of War: Ragnarök"), "God_of_War_Ragnarok");
    assert.equal(sanitizeGameName("Cyberpunk 2077"), "Cyberpunk_2077");
    assert.equal(sanitizeGameName("Demon's Souls - Remake"), "Demons_Souls_Remake");
    assert.equal(sanitizeGameName("_No response_"), "Unknown_Game");
  });

  test("version normalization handles dots, underscores, and backticks", () => {
    assert.equal(normalizeVersionToFilename("01.905.000"), "01_905_000");
    assert.equal(normalizeVersionToFilename("`01_905_000`"), "01_905_000");
    assert.equal(normalizeVersionToDisplay("01_905_000"), "01.905.000");
    assert.throws(() => normalizeVersionToFilename("1.0"), /Invalid version format/);
  });

  test("validateTitleId accepts valid PPSA with quotes or backticks", () => {
    assert.equal(validateTitleId("ppsa01325"), "PPSA01325");
    assert.equal(validateTitleId("`PPSA28997`"), "PPSA28997");
    assert.throws(() => validateTitleId("INVALID"), /Invalid Title ID/);
  });

  test("getNextModuleFilename increments sequentially", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "kyty-test-"));
    try {
      const f1 = await getNextModuleFilename(tmpDir, "PPSA01325", "01_905_000", "Astros_Playroom");
      assert.equal(f1, "PPSA01325_01_905_000_Astros_Playroom_1.json");
      await writeFile(path.join(tmpDir, f1), "{}");

      const f2 = await getNextModuleFilename(tmpDir, "PPSA01325", "01_905_000", "Astros_Playroom");
      assert.equal(f2, "PPSA01325_01_905_000_Astros_Playroom_2.json");
      await writeFile(path.join(tmpDir, f2), "{}");

      const f3 = await getNextModuleFilename(tmpDir, "PPSA01325", "01_905_000", "Astros_Playroom");
      assert.equal(f3, "PPSA01325_01_905_000_Astros_Playroom_3.json");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("validateModuleJson validates payload strictly", () => {
    const valid = { id: "PPSA01325", version: "01.905.000", name: "60 FPS" };
    assert.ok(validateModuleJson(valid, "PPSA01325", "01_905_000", { isStrict: true }));

    // Empty object must fail strict validation
    assert.throws(() => validateModuleJson({}, "PPSA01325", "01_905_000", { isStrict: true }), /Missing required field 'id'/);

    // Mismatched ID must fail
    const mismatchedId = { id: "PPSA99999", version: "01.905.000", name: "Test" };
    assert.throws(() => validateModuleJson(mismatchedId, "PPSA01325", "01_905_000"), /does not match/);

    // Malformed mods array must fail
    const badMods = { id: "PPSA01325", version: "01.905.000", name: "Test", mods: "not-an-array" };
    assert.throws(() => validateModuleJson(badMods, "PPSA01325", "01_905_000"), /must be an array/);
  });
});
