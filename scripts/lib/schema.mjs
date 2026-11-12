import path from "node:path";
import { readdir } from "node:fs/promises";

// Matches: PPSA01325_01_905_000_Astros_Playroom_1.json
// Accommodates unindexed PPSA01325_01_905_000_Astros_Playroom.json gracefully
export const FILENAME_REGEX =
  /^([A-Z]{4}\d{5})_(\d{2}_\d{3}_\d{3})_([A-Za-z0-9]+(?:_[A-Za-z0-9]+)*?)(?:_(\d+))?\.json$/;

// Strict regex where numeric index suffix is required (_1, _2, ...)
export const STRICT_FILENAME_REGEX =
  /^([A-Z]{4}\d{5})_(\d{2}_\d{3}_\d{3})_([A-Za-z0-9]+(?:_[A-Za-z0-9]+)*)_(\d+)\.json$/;

export const CATEGORIES = ["patches", "cheats", "configs"];

export const CATEGORY_SINGULAR = {
  patches: "patch",
  cheats: "cheat",
  configs: "config",
};

/**
 * Strips surrounding backticks, single/double quotes, and whitespace.
 */
export function cleanInputString(val) {
  if (!val) return "";
  return String(val)
    .trim()
    .replace(/^[`'"]+|[`'"]+$/g, "")
    .trim();
}

/**
 * Normalizes a game title into a clean filename slug.
 * e.g. "Astro's Playroom" -> "Astros_Playroom"
 * "God of War: Ragnarök" -> "God_of_War_Ragnarok"
 */
export function sanitizeGameName(name) {
  const cleaned = cleanInputString(name);
  if (!cleaned || cleaned.toLowerCase() === "_no response_") return "Unknown_Game";
  return (
    cleaned
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "") // strip diacritics
      .replace(/['’]/g, "") // remove quotes
      .replace(/[^A-Za-z0-9]+/g, "_") // replace non-alphanumeric with underscore
      .replace(/^_+|_+$/g, "") || "Unknown_Game" // trim underscores
  );
}

/**
 * Normalizes version strings from '01.905.000' or '01_905_000' to '01_905_000'.
 */
export function normalizeVersionToFilename(ver) {
  const clean = cleanInputString(ver).replace(/\./g, "_");
  if (!/^\d{2}_\d{3}_\d{3}$/.test(clean)) {
    throw new Error(`Invalid version format: "${ver}". Expected format: 01.905.000 or 01_905_000.`);
  }
  return clean;
}

/**
 * Converts version from filename '01_905_000' back to display '01.905.000'.
 */
export function normalizeVersionToDisplay(ver) {
  return cleanInputString(ver).replace(/_/g, ".");
}

/**
 * Validates a title ID (e.g. PPSA01325).
 */
export function validateTitleId(id) {
  const clean = cleanInputString(id).toUpperCase();
  if (!/^[A-Z]{4}\d{5}$/.test(clean)) {
    throw new Error(`Invalid Title ID: "${id}". Expected format like PPSA01325.`);
  }
  return clean;
}

/**
 * Finds the next available incrementing filename for a PPSA and version.
 * Always increments starting from _1.json (e.g. PPSA01325_01_905_000_Astros_Playroom_1.json).
 */
export async function getNextModuleFilename(categoryDir, ppsa, versionUnderScore, gameName) {
  let existingFiles = [];
  try {
    existingFiles = await readdir(categoryDir);
  } catch {
    existingFiles = [];
  }

  const prefix = `${ppsa}_${versionUnderScore}_${gameName}`;
  const pattern = new RegExp(`^${prefix}(?:_(\\d+))?\\.json$`);
  let maxIndex = 0;

  for (const file of existingFiles) {
    const match = file.match(pattern);
    if (match) {
      if (match[1]) {
        const idx = parseInt(match[1], 10);
        if (idx > maxIndex) maxIndex = idx;
      } else {
        if (maxIndex === 0) maxIndex = 1;
      }
    }
  }

  const nextIndex = maxIndex + 1;
  return `${prefix}_${nextIndex}.json`;
}

/**
 * Validates module JSON content structure.
 */
export function validateModuleJson(parsed, expectedId = null, expectedVersion = null, { isStrict = true, category = null } = {}) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Module file must be a JSON object.");
  }

  if (isStrict) {
    if (!parsed.id) throw new Error("Missing required field 'id' in module JSON.");
    if (!parsed.version) throw new Error("Missing required field 'version' in module JSON.");
    if (!parsed.name && !parsed.title) throw new Error("Missing required field 'name' or 'title' in module JSON.");
  }

  if (expectedId && parsed.id) {
    const jsonId = String(parsed.id).trim().toUpperCase();
    if (jsonId !== expectedId) {
      throw new Error(`Title ID in JSON ("${jsonId}") does not match expected "${expectedId}".`);
    }
  }

  if (expectedVersion && parsed.version) {
    const jsonVer = normalizeVersionToFilename(parsed.version);
    const expVer = normalizeVersionToFilename(expectedVersion);
    if (jsonVer !== expVer) {
      throw new Error(`Version in JSON ("${parsed.version}") does not match expected "${expectedVersion}".`);
    }
  }

  // If mods array is present (patches/cheats), validate structure
  if (parsed.mods !== undefined) {
    if (!Array.isArray(parsed.mods)) {
      throw new Error("Field 'mods' must be an array.");
    }
    for (const [i, mod] of parsed.mods.entries()) {
      if (!mod || typeof mod !== "object" || Array.isArray(mod)) {
        throw new Error(`mods[${i}] must be an object.`);
      }
      if (typeof mod.name !== "string" || !mod.name.trim()) {
        throw new Error(`mods[${i}].name must be a non-empty string.`);
      }
      if (mod.memory !== undefined && !Array.isArray(mod.memory)) {
        throw new Error(`mods[${i}].memory must be an array.`);
      }
    }
  }

  return true;
}
