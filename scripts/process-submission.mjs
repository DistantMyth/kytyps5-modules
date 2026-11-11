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

function parseCommentCommand(body) {
  const lines = body.split(/\r?\n/);
  let command = null;
  let titleId = null;
  let version = null;
  let title = null;
  let description = "";
  let inDesc = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!command) {
      const cmdMatch = line.match(/^\/(patch|cheat|config)\s+([A-Za-z0-9]+)\s+(\S+)/i);
      if (cmdMatch) {
        command = cmdMatch[1].toLowerCase();
        titleId = cmdMatch[2].toUpperCase();
        version = cmdMatch[3];
        continue;
      }
    }

    const titleMatch = line.match(/^\/title\s+(.+)$/i);
    if (titleMatch) {
      title = titleMatch[1].trim();
      inDesc = false;
      continue;
    }

    const descMatch = line.match(/^\/description\s*(.*)$/i);
    if (descMatch) {
      inDesc = true;
      if (descMatch[1].trim()) {
        description += (description ? "\n" : "") + descMatch[1].trim();
      }
      continue;
    }

    if (inDesc && line && !line.startsWith("/")) {
      description += (description ? "\n" : "") + line;
    }
  }

  return { command, titleId, version, title, description };
}

async function run() {
  const eventName = process.env.EVENT_NAME;
  const event = JSON.parse(process.env.EVENT_PAYLOAD || "{}");
  const ghToken = process.env.GH_TOKEN;

  let category = null;
  let rawTitleId = null;
  let rawVersion = null;
  let gameNameInput = null;
  let modTitle = null;
  let description = "";
  let attachmentUrl = null;
  let author = "community";
  let authorAssociation = "NONE";
  let issueNumber = 0;

  if (eventName === "issue_comment") {
    const comment = event.comment || {};
    const issue = event.issue || {};
    author = comment.user?.login || "community";
    authorAssociation = comment.author_association || "NONE";
    issueNumber = issue.number || 0;

    const parsedCmd = parseCommentCommand(comment.body || "");
    if (!parsedCmd.command) {
      throw new Error("No valid /patch, /cheat, or /config command found in comment.");
    }

    category = parsedCmd.command === "config" ? "configs" : `${parsedCmd.command}es`;
    if (parsedCmd.command === "cheat") category = "cheats";

    rawTitleId = parsedCmd.titleId;
    rawVersion = parsedCmd.version;
    modTitle = parsedCmd.title;
    description = parsedCmd.description;
    attachmentUrl = extractAttachmentUrl(comment.body || "");
  } else if (eventName === "issues") {
    const issue = event.issue || {};
    author = issue.user?.login || "community";
    authorAssociation = issue.author_association || "NONE";
    issueNumber = issue.number || 0;

    const sections = parseIssueFormBody(issue.body || "");
    const labels = (issue.labels || []).map((l) => (typeof l === "string" ? l : l.name));

    if (labels.includes("cheat") || issue.title?.toLowerCase().includes("[cheat]")) {
      category = "cheats";
    } else if (labels.includes("config") || issue.title?.toLowerCase().includes("[config]")) {
      category = "configs";
    } else {
      category = "patches";
    }

    rawTitleId = sections["title id"] || sections["game id"];
    rawVersion = sections["game version"] || sections["version"];
    gameNameInput = sections["game name"];
    modTitle = sections["patch title"] || sections["cheat title"] || sections["config title"] || sections["title"];
    description = sections["detailed description"] || sections["description"] || "";
    attachmentUrl = extractAttachmentUrl(sections["json file attachment"] || issue.body || "");
  } else {
    throw new Error(`Unsupported event: ${eventName}`);
  }

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
