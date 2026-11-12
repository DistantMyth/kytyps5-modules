import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import {
  CATEGORIES,
  CATEGORY_SINGULAR,
  sanitizeGameName,
  normalizeVersionToFilename,
  normalizeVersionToDisplay,
  validateTitleId,
  getNextModuleFilename,
  validateModuleJson,
  cleanInputString,
} from "./lib/schema.mjs";

const ERROR_FILE = path.join(os.tmpdir(), "submission-error.txt");
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

const KNOWN_FIELDS = new Set([
  "title id",
  "game id",
  "game version",
  "version",
  "game name",
  "patch title",
  "cheat title",
  "config title",
  "title",
  "detailed description",
  "description",
  "json file attachment",
]);

function parseIssueFormBody(body) {
  const sections = Object.create(null);
  const regex = /^###\s+([^\r\n]+)\r?\n([\s\S]*?)(?=^###\s+|$)/gm;
  let match;
  while ((match = regex.exec(body)) !== null) {
    const key = match[1].trim().toLowerCase();
    const val = match[2].trim();
    if (KNOWN_FIELDS.has(key)) {
      sections[key] = val;
    }
  }
  return sections;
}

function cleanFieldValue(val) {
  if (!val) return undefined;
  const cleaned = cleanInputString(val);
  if (!cleaned || cleaned.toLowerCase() === "_no response_") return undefined;
  return cleaned;
}

function extractAttachmentUrl(text) {
  // Only permit legitimate GitHub attachment endpoints (pre-signed files or repo file uploads)
  const trustedAttachmentRegex =
    /https:\/\/(?:github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/files\/\d+\/[^\s)]+\.json|github\.com\/user-attachments\/files\/\d+\/[^\s)]+\.json)/i;
  const match = text.match(trustedAttachmentRegex);
  return match ? match[0] : null;
}

async function writeFailure(msg) {
  try {
    const sanitized = String(msg || "")
      .replace(/[`$"\\<>{}]/g, "")
      .trim()
      .slice(0, 500);
    await writeFile(ERROR_FILE, sanitized, "utf8");
  } catch {}
}

function formatOutput(key, value) {
  const str = String(value ?? "");
  if (str.includes("\n")) {
    const delimiter = `EOF_${randomUUID().replace(/-/g, "")}`;
    return `${key}<<${delimiter}\n${str}\n${delimiter}`;
  }
  return `${key}=${str}`;
}

async function run() {
  const eventName = process.env.EVENT_NAME;
  const eventPath = process.env.GITHUB_EVENT_PATH;

  let event = {};
  if (eventPath) {
    event = JSON.parse(await readFile(eventPath, "utf8"));
  }

  if (eventName !== "issues") {
    throw new Error(`Only Issue Form submissions are supported. Received event: ${eventName}`);
  }

  const issue = event.issue || {};
  const author = issue.user?.login || "community";
  const authorAssociation = issue.author_association || "NONE";
  const issueNumber = issue.number || 0;

  const sections = parseIssueFormBody(issue.body || "");
  const labels = (issue.labels || []).map((l) => (typeof l === "string" ? l : l.name));

  let category = "patches";
  if (labels.includes("cheat") || issue.title?.toLowerCase().includes("[cheat]")) {
    category = "cheats";
  } else if (labels.includes("config") || issue.title?.toLowerCase().includes("[config]")) {
    category = "configs";
  } else {
    category = "patches";
  }

  const rawTitleId = cleanFieldValue(sections["title id"] || sections["game id"]);
  const rawVersion = cleanFieldValue(sections["game version"] || sections["version"]);
  const gameNameInput = cleanFieldValue(sections["game name"]);
  const modTitle = cleanFieldValue(
    sections["patch title"] || sections["cheat title"] || sections["config title"] || sections["title"]
  );
  const description = cleanFieldValue(sections["detailed description"] || sections["description"]) || "";
  const attachmentField = (sections["json file attachment"] || "").trim();

  if (!rawTitleId) throw new Error("Missing Title ID (e.g. PPSA01325).");
  if (!rawVersion) throw new Error("Missing Version (e.g. 01.905.000 or 01_905_000).");

  const ppsa = validateTitleId(rawTitleId);
  const versionScore = normalizeVersionToFilename(rawVersion);
  const versionDisplay = normalizeVersionToDisplay(versionScore);

  let jsonText = "";

  // Strip markdown code fences if user pasted raw JSON
  const cleanAttachment = attachmentField.replace(/^```(?:json)?\s*|\s*```$/gi, "").trim();

  if (cleanAttachment.startsWith("{") && cleanAttachment.endsWith("}")) {
    jsonText = cleanAttachment;
  } else {
    const attachmentUrl = extractAttachmentUrl(cleanAttachment || issue.body || "");
    if (!attachmentUrl) {
      throw new Error(
        "No valid GitHub attachment link or inline JSON found in submission. Please upload a .json file or paste valid JSON."
      );
    }

    console.log(`[INFO] Fetching attachment from: ${attachmentUrl}`);
    // Enforce 15-second timeout and DO NOT send auth headers to pre-signed URLs
    const res = await fetch(attachmentUrl, {
      headers: { "User-Agent": "kytyps5-modules-bot" },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      throw new Error(`Failed to download attached JSON (${res.status} ${res.statusText}).`);
    }

    const contentLength = parseInt(res.headers.get("content-length") || "0", 10);
    if (contentLength > MAX_FILE_SIZE_BYTES) {
      throw new Error(`Attachment exceeds maximum allowed size of 5 MB (${(contentLength / 1024 / 1024).toFixed(1)} MB).`);
    }

    jsonText = await res.text();
    if (jsonText.length > MAX_FILE_SIZE_BYTES) {
      throw new Error("Attachment text exceeds maximum allowed size of 5 MB.");
    }
  }

  let parsedJson;
  try {
    parsedJson = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`Attached file is not valid JSON: ${err.message}`);
  }

  // Populate/enrich basic metadata if missing before strict validation
  if (!parsedJson.id) parsedJson.id = ppsa;
  if (!parsedJson.version) parsedJson.version = versionDisplay;
  if (modTitle && !parsedJson.name && !parsedJson.title) parsedJson.name = modTitle;
  if (description && !parsedJson.description) parsedJson.description = description;
  parsedJson.author = author;

  validateModuleJson(parsedJson, ppsa, versionScore, { isStrict: true, category });

  // If game name wasn't explicitly supplied, try parsing from JSON name or fallback to PPSA
  const resolvedGameName = sanitizeGameName(
    gameNameInput || parsedJson.name || parsedJson.gameName || ppsa
  );

  const categoryDir = path.join(process.cwd(), category, "json");
  await mkdir(categoryDir, { recursive: true });

  const filename = await getNextModuleFilename(categoryDir, ppsa, versionScore, resolvedGameName);
  const targetFilePath = path.join(categoryDir, filename);

  await writeFile(targetFilePath, JSON.stringify(parsedJson, null, 2) + "\n");
  console.log(`[INFO] Successfully written module to ${category}/json/${filename}`);

  const singular = CATEGORY_SINGULAR[category] || category;
  const isCollaborator = ["OWNER", "MEMBER", "COLLABORATOR"].includes(authorAssociation);
  const branchSuffix = `${singular}-${ppsa}-${versionScore}-i${issueNumber}`;

  // Sanitize PR title: single line, no backticks/quotes, max 80 chars
  const safeModTitle = (modTitle || parsedJson.name || resolvedGameName)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/["`]/g, "")
    .trim()
    .slice(0, 80);
  const prTitle = `${category}: ${ppsa} (${versionDisplay}) - ${safeModTitle} (@${author})`;

  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    const outputs = [
      formatOutput("category", category),
      formatOutput("title_id", ppsa),
      formatOutput("version", versionDisplay),
      formatOutput("filename", filename),
      formatOutput("author", author),
      formatOutput("is_collaborator", isCollaborator ? "true" : "false"),
      formatOutput("branch_suffix", branchSuffix),
      formatOutput("pr_title", prTitle),
    ].join("\n");
    await writeFile(out, outputs + "\n", { flag: "a" });
  }
}

run().catch(async (err) => {
  console.error(`[ERROR] ${err.message}`);
  await writeFailure(err.message);
  process.exit(1);
});
