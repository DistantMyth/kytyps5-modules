import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CATEGORIES,
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
  // Matches markdown links: [file.json](https://github.com/...) or raw URLs
  const mdMatch = text.match(/\[([^\]]*\.json)\]\((https:\/\/[^\s)]+)\)/i);
  if (mdMatch) return mdMatch[2];

  const urlMatch = text.match(/(https:\/\/(?:github\.com|user-images\.githubusercontent\.com)[^\s)]+?\.json(?:[^\s)]*)?)/i);
  if (urlMatch) return urlMatch[1];

  // Also match generic github user-attachments/files/... links
  const attachmentMatch = text.match(/(https:\/\/[^\s)]*github\.com\/[^\s)]*files\/[^\s)]+)/i);
  if (attachmentMatch) return attachmentMatch[1];

  return null;
}

async function run() {
  const eventName = process.env.EVENT_NAME;
  const event = JSON.parse(process.env.EVENT_PAYLOAD || "{}");
  const ghToken = process.env.GH_TOKEN;

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

  const rawTitleId = sections["title id"] || sections["game id"];
  const rawVersion = sections["game version"] || sections["version"];
  const gameNameInput = sections["game name"];
  const modTitle = sections["patch title"] || sections["cheat title"] || sections["config title"] || sections["title"];
  const description = sections["detailed description"] || sections["description"] || "";
  const attachmentUrl = extractAttachmentUrl(sections["json file attachment"] || issue.body || "");

  if (!rawTitleId) throw new Error("Missing Title ID (e.g. PPSA01325).");
  if (!rawVersion) throw new Error("Missing Version (e.g. 01.905.000).");
  if (!attachmentUrl) throw new Error("No attached JSON file found in submission.");

  const ppsa = validateTitleId(rawTitleId);
  const versionScore = normalizeVersionToFilename(rawVersion);
  const versionDisplay = normalizeVersionToDisplay(versionScore);

  console.log(`[INFO] Fetching attachment from: ${attachmentUrl}`);
  const fetchHeaders = { "User-Agent": "kytyps5-modules-bot" };
  if (ghToken) fetchHeaders["Authorization"] = `Bearer ${ghToken}`;

  const res = await fetch(attachmentUrl, { headers: fetchHeaders });
  if (!res.ok) {
    throw new Error(`Failed to download attached JSON (${res.status} ${res.statusText}).`);
  }

  const jsonText = await res.text();
  let parsedJson;
  try {
    parsedJson = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`Attached file is not valid JSON: ${err.message}`);
  }

  validateModuleJson(parsedJson, ppsa, versionScore);

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

  const isCollaborator = ["OWNER", "MEMBER", "COLLABORATOR"].includes(authorAssociation);
  const branchSuffix = `${category.slice(0, -1)}-${ppsa}-${versionScore}-i${issueNumber}`;
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
