import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import {
  extractArticlesTextFromFile,
  parseArticlesText
} from "./articlesParser.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendRoot = path.resolve(__dirname, "../../frontend");

function safeParseJson(value) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
}

function hasParsedArticlesData(parsedFields = {}) {
  return Object.values(parsedFields).some((value) => value != null && value !== "");
}

export async function ensureStartupArticlesParsed(connection, document) {
  if (!document?.id || !document?.url) {
    return document || null;
  }

  const existingParsedFields = safeParseJson(document.parsed_fields_json);
  if (
    (document.parse_status === "parsed_complete" || document.parse_status === "parsed_partial")
    && hasParsedArticlesData(existingParsedFields)
  ) {
    return {
      ...document,
      parsed_fields_json: JSON.stringify(existingParsedFields),
      extracted_text: document.extracted_text || null
    };
  }

  const absolutePath = path.resolve(frontendRoot, document.url);

  try {
    await fs.access(absolutePath);
  } catch {
    return {
      ...document,
      parsed_fields_json: JSON.stringify(existingParsedFields),
      extracted_text: document.extracted_text || null
    };
  }

  const extractedText = await extractArticlesTextFromFile(absolutePath, document.mime_type || "application/pdf");
  const parsed = parseArticlesText(extractedText);

  await connection.query(
    `
    UPDATE startup_documents
    SET parse_status = ?, parsed_fields_json = ?, extracted_text = ?
    WHERE id = ?
    `,
    [
      parsed.parseStatus,
      JSON.stringify(parsed.parsedFields || {}),
      parsed.extractedText || null,
      document.id
    ]
  );

  return {
    ...document,
    parse_status: parsed.parseStatus,
    parsed_fields_json: JSON.stringify(parsed.parsedFields || {}),
    extracted_text: parsed.extractedText || null
  };
}
