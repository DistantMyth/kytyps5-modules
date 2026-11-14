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
    assert.ok(STRICT_FILENAME_REGEX.test("PPSA01234_01_000_000_F1_2023_1.json"));

    // Invalid cases:
    assert.ok(!STRICT_FILENAME_REGEX.test("PPSA01325_01.905.000_Astros_1.json")); // dots in version
    assert.ok(!STRICT_FILENAME_REGEX.test("ppsa01325_01_905_000_Astros_1.json")); // lowercase ID
    assert.ok(!STRICT_FILENAME_REGEX.test("PPSA01325_01_905_000_1.json")); // missing game name
  });

  test("cleanInputString removes quotes, backticks and handles number 0", () => {
    assert.equal(cleanInputString("`PPSA01325`"), "PPSA01325");
    assert.equal(cleanInputString('"01.905.000"'), "01.905.000");
    assert.equal(cleanInputString("'Astro's Playroom'"), "Astro's Playroom");
    assert.equal(cleanInputString(0), "0");
    assert.equal(cleanInputString(null), "");
    assert.equal(cleanInputString(undefined), "");
  });

  test("sanitizeGameName converts special characters and spaces cleanly", () => {
    assert.equal(sanitizeGameName("Astro's Playroom"), "Astros_Playroom");
    assert.equal(sanitizeGameName("God of War: Ragnarök"), "God_of_War_Ragnarok");
    assert.equal(sanitizeGameName("Cyberpunk 2077"), "Cyberpunk_2077");
    assert.equal(sanitizeGameName("Demon's Souls - Remake"), "Demons_Souls_Remake");
    assert.equal(sanitizeGameName("_No response_"), "Unknown_Game");
  });

  test("version normalization automatically converts dots to underscores and pads", () => {
    // Standard formats with dots are converted to underscores
    assert.equal(normalizeVersionToFilename("01.905.000"), "01_905_000");
    assert.equal(normalizeVersionToFilename("01.008.001"), "01_008_001");
    assert.equal(normalizeVersionToFilename("`01.905.000`"), "01_905_000");

    // Standard formats with underscores remain underscores
    assert.equal(normalizeVersionToFilename("01_905_000"), "01_905_000");
    assert.equal(normalizeVersionToFilename("`01_905_000`"), "01_905_000");

    // Variations with missing leading zeroes or 2 parts are padded and converted
    assert.equal(normalizeVersionToFilename("1.905.000"), "01_905_000");
    assert.equal(normalizeVersionToFilename("1.018"), "01_018_000");
    assert.equal(normalizeVersionToFilename("01.018"), "01_018_000");
    assert.equal(normalizeVersionToFilename("1.0"), "01_000_000");
    assert.equal(normalizeVersionToFilename("1.0.0"), "01_000_000");
    assert.equal(normalizeVersionToFilename("1_018"), "01_018_000");

    // Display version returns standard dot format
    assert.equal(normalizeVersionToDisplay("01.905.000"), "01.905.000");
    assert.equal(normalizeVersionToDisplay("01_905_000"), "01.905.000");
    assert.equal(normalizeVersionToDisplay("1.018"), "01.018.000");
    assert.equal(normalizeVersionToDisplay("1_018"), "01.018.000");
    assert.equal(normalizeVersionToDisplay("`01_905_000`"), "01.905.000");

    // Invalid formats throw cleanly
    assert.throws(() => normalizeVersionToFilename("not_a_version"), /Invalid version format/);
    assert.throws(() => normalizeVersionToFilename("01.02.03.04"), /Invalid version format/);
  });

  test("validateTitleId accepts valid PPSA with quotes or backticks", () => {
    assert.equal(validateTitleId("ppsa01325"), "PPSA01325");
    assert.equal(validateTitleId("`PPSA28997`"), "PPSA28997");
    assert.throws(() => validateTitleId("INVALID"), /Invalid Title ID/);
  });

  test("getNextModuleFilename increments sequentially across game name variations", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "kyty-test-"));
    try {
      const f1 = await getNextModuleFilename(tmpDir, "PPSA01325", "01_905_000", "Astros_Playroom");
      assert.equal(f1, "PPSA01325_01_905_000_Astros_Playroom_1.json");
      await writeFile(path.join(tmpDir, f1), "{}");

      const f2 = await getNextModuleFilename(tmpDir, "PPSA01325", "01_905_000", "Astros_Playroom_DLSS");
      assert.equal(f2, "PPSA01325_01_905_000_Astros_Playroom_DLSS_2.json");
      await writeFile(path.join(tmpDir, f2), "{}");

      const f3 = await getNextModuleFilename(tmpDir, "PPSA01325", "01_905_000", "Astros_Playroom");
      assert.equal(f3, "PPSA01325_01_905_000_Astros_Playroom_3.json");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("validateModuleJson validates payload with dots or underscores in version", () => {
    // When input version has dots and payload has underscores, or vice versa
    const withDots = { id: "PPSA01325", version: "01.905.000", name: "60 FPS" };
    const withUnderscores = { id: "PPSA01325", version: "01_905_000", name: "60 FPS" };

    assert.ok(validateModuleJson(withDots, "PPSA01325", "01_905_000", { isStrict: true }));
    assert.ok(validateModuleJson(withUnderscores, "PPSA01325", "01.905.000", { isStrict: true }));
    assert.ok(validateModuleJson(withDots, "PPSA01325", "01.905.000", { isStrict: true }));
    assert.ok(validateModuleJson(withUnderscores, "PPSA01325", "01_905_000", { isStrict: true }));

    // Empty object must fail strict validation
    assert.throws(() => validateModuleJson({}, "PPSA01325", "01_905_000", { isStrict: true }), /Missing required field 'id'/);

    // Mismatched ID must fail
    const mismatchedId = { id: "PPSA99999", version: "01_905_000", name: "Test" };
    assert.throws(() => validateModuleJson(mismatchedId, "PPSA01325", "01_905_000"), /does not match/);

    // Invalid memory offset
    assert.throws(
      () =>
        validateModuleJson(
          { ...withUnderscores, mods: [{ name: "Mod", memory: [{ offset: "not-hex", on: "00", off: "00" }] }] },
          "PPSA01325",
          "01_905_000"
        ),
      /offset must be a hex address string/
    );

    // Odd-length hex
    assert.throws(
      () =>
        validateModuleJson(
          { ...withUnderscores, mods: [{ name: "Mod", memory: [{ offset: "0x1234", on: "001", off: "000" }] }] },
          "PPSA01325",
          "01_905_000"
        ),
      /must be an even-length hex string/
    );

    // Mismatched length between on and off
    assert.throws(
      () =>
        validateModuleJson(
          { ...withUnderscores, mods: [{ name: "Mod", memory: [{ offset: "0x1234", on: "0011", off: "00" }] }] },
          "PPSA01325",
          "01_905_000"
        ),
      /must equal 'off' length/
    );
  });
});
