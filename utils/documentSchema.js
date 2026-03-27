import db from "../config/db.js";

function parseEnumValues(columnType) {
  const match = String(columnType || "").match(/^enum\((.*)\)$/i);
  if (!match) return [];

  return match[1]
    .split(",")
    .map((value) => value.trim().replace(/^'/, "").replace(/'$/, "").replace(/\\'/g, "'"))
    .filter(Boolean);
}

export async function ensureDocumentSchema() {
  const connection = await db.getConnection();

  try {
    const [rows] = await connection.query("SHOW COLUMNS FROM documents LIKE 'type'");
    const typeColumn = rows[0];

    if (!typeColumn) {
      return;
    }

    const currentType = String(typeColumn.Type || "");
    if (!currentType.toLowerCase().startsWith("enum(")) {
      return;
    }

    const values = parseEnumValues(currentType);
    const requiredValues = ["SFC", "GFC"];
    const missingValues = requiredValues.filter((value) => !values.includes(value));

    if (!missingValues.length) {
      return;
    }

    const nextValues = [...values, ...missingValues];
    const enumSql = nextValues.map((value) => `'${value.replace(/'/g, "\\'")}'`).join(", ");
    const nullable = String(typeColumn.Null || "").toUpperCase() === "YES" ? "NULL" : "NOT NULL";
    const defaultSql = typeColumn.Default == null
      ? ""
      : ` DEFAULT '${String(typeColumn.Default).replace(/'/g, "\\'")}'`;

    await connection.query(
      `ALTER TABLE documents MODIFY COLUMN type ENUM(${enumSql}) ${nullable}${defaultSql}`
    );
  } finally {
    connection.release();
  }
}
