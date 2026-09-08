const tableCache = new Map();
const columnCache = new Map();
const columnsCache = new Map();

function cached(cache, key, loader) {
  if (!cache.has(key)) {
    const pending = Promise.resolve().then(loader).catch((error) => {
      cache.delete(key);
      throw error;
    });
    cache.set(key, pending);
  }
  return cache.get(key);
}

export function tableExists(connection, tableName) {
  return cached(tableCache, tableName, async () => {
    const [rows] = await connection.query(
      `SELECT 1 FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1`,
      [tableName]
    );
    return rows.length > 0;
  });
}

export function columnExists(connection, tableName, columnName) {
  const key = `${tableName}.${columnName}`;
  return cached(columnCache, key, async () => {
    const columns = await getTableColumns(connection, tableName);
    return columns.has(columnName);
  });
}

export function getTableColumns(connection, tableName) {
  if (!/^[A-Za-z0-9_]+$/.test(String(tableName))) {
    throw new Error("Invalid schema table name");
  }
  return cached(columnsCache, tableName, async () => {
    const [rows] = await connection.query(`SHOW COLUMNS FROM \`${tableName}\``);
    return new Set(rows.map((row) => row.Field));
  });
}

export function clearSchemaCapabilityCache() {
  tableCache.clear();
  columnCache.clear();
  columnsCache.clear();
}
