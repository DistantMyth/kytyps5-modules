import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CATEGORIES,
  CATEGORY_SINGULAR,
  sanitizeGameName,
  normalizeVersionToFilename,
  normalizeVersionToDisplay,
  validateTitleId,
  getNextModuleFilename,
  validateModuleJson,
} from "./lib/schema.mjs";

function parseIssueFormBody(body) {
  const sections = {};
  const regex = /###\s+([^\r\n]+)\r?\n+([\s\S]*?)(?=(?:\r?\n###\s+|$))/g;
  let match;
  while ((match = regex.exec(body)) !== null) {
    const key = match[1].trim().toLowerCase();
    const val = match[2].trim();
    sections[key] = val;
  }
  return sections;
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
    await writeFile("/tmp/submission-error.txt", msg);
  } catch {}
}

async function run() {
  const eventName = process.env.EVENT_NAME;
  const eventPath = process.env.GITHUB_EVENT_PATH;

  let event = {};
  if (eventPath) {
    event = JSON.parse(await readFile(eventPath, "utf8"));
  }

  if (eventName !== "issues") {
    const msg = `Only Issue Form submissions are supported. Received event: ${eventName}`;
    await writeFailure(msg);
    throw new Error(msg);
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

  const rawTitleId = sections["title id"] || sections["game id"];
  const rawVersion = sections["game version"] || sections["version"];
  const gameNameInput = sections["game name"];
  const modTitle = sections["patch title"] || sections["cheat title"] || sections["config title"] || sections["title"];
  const description = sections["detailed description"] || sections["description"] || "";
  const attachmentField = (sections["json file attachment"] || "").trim();

  if (!rawTitleId) {
    const msg = "Missing Title ID (e.g. `PPSA01325`).";
    await writeFailure(msg);
    throw new Error(msg);
  }
  if (!rawVersion) {
    const msg = "Missing Version (e.g. `01.905.000` or `01_905_000`).";
    await writeFailure(msg);
    throw new Error(msg);
  }

  let ppsa, versionScore, versionDisplay;
  try {
    ppsa = validateTitleId(rawTitleId);
    versionScore = normalizeVersionToFilename(rawVersion);
    versionDisplay = normalizeVersionToDisplay(versionScore);
  } catch (err) {
    await writeFailure(err.message);
    throw err;
  }

  let jsonText = "";

  // Support both raw JSON pasted into textarea and GitHub file attachments
  if (attachmentField.startsWith("{") && attachmentField.endsWith("}")) {
    jsonText = attachmentField;
  } else {
    const attachmentUrl = extractAttachmentUrl(attachmentField || issue.body || "");
    if (!attachmentUrl) {
      const msg =
        "No valid GitHub attachment link or inline JSON found in submission. Please upload a `.json` file or paste valid JSON.";
      await writeFailure(msg);
      throw new Error(msg);
    }

    console.log(`[INFO] Fetching attachment from: ${attachmentUrl}`);
    // NEVER send auth tokens to external attachment URLs (pre-signed S3 URLs)
    const res = await fetch(attachmentUrl, {
      headers: { "User-Agent": "kytyps5-modules-bot" },
    });

    if (!res.ok) {
      const msg = `Failed to download attached JSON (${res.status} ${res.statusText}).`;
      await writeFailure(msg);
      throw new Error(msg);
    }
    jsonText = await res.text();
  }

  let parsedJson;
  try {
    parsedJson = JSON.parse(jsonText);
  } catch (err) {
    const msg = `Attached file is not valid JSON: ${err.message}`;
    await writeFailure(msg);
    throw new Error(msg);
  }

  try {
    validateModuleJson(parsedJson, ppsa, versionScore);
  } catch (err) {
    await writeFailure(err.message);
    throw err;
  }

  // If game name wasn't explicitly supplied, try parsing from JSON name or fallback to PPSA
  const resolvedGameName = sanitizeGameName(
    gameNameInput || parsedJson.name || parsedJson.gameName || ppsa
  );

  // Enrich JSON metadata if missing
  if (!parsedJson.id) parsedJson.id = ppsa;
  if (!parsedJson.version) parsedJson.version = versionDisplay;
  if (modTitle && !parsedJson.name) parsedJson.name = modTitle;
  if (description && !parsedJson.description) parsedJson.description = description;
  parsedJson.author = author;

  const categoryDir = path.join(process.cwd(), category, "json");
  const filename = await getNextModuleFilename(categoryDir, ppsa, versionScore, resolvedGameName);
  const targetFilePath = path.join(categoryDir, filename);

  await writeFile(targetFilePath, JSON.stringify(parsedJson, null, 2) + "\n");
  console.log(`[INFO] Successfully written module to ${category}/json/${filename}`);

  const singular = CATEGORY_SINGULAR[category] || category;
  const isCollaborator = ["OWNER", "MEMBER", "COLLABORATOR"].includes(authorAssociation);
  const branchSuffix = `${singular}-${ppsa}-${versionScore}-i${issueNumber}`;
  const prTitle = `${category}: ${ppsa} (${versionDisplay}) - ${modTitle || resolvedGameName} (@${author})`;

  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    const outputs = [
      `category=${category}`,
      `title_id=${ppsa}`,
      `version=${versionDisplay}`,
      `filename=${filename}`,
      `author=${author}`,
      `is_collaborator=${isCollaborator ? "true" : "false"}`,
      `branch_suffix=${branchSuffix}`,
      `pr_title=${prTitle}`,
    ].join("\n");
    await writeFile(out, outputs + "\n", { flag: "a" });
  }
}

run().catch((err) => {
  console.error(`[ERROR] ${err.message}`);
  process.exit(1);
});
