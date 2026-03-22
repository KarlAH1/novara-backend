export async function cleanupLegalDocuments(db, startupId, types = ["BOARD", "GF"]) {
  if (!types.length) {
    return;
  }

  const typePlaceholders = types.map(() => "?").join(", ");
  const [documentRows] = await db.query(
    `
    SELECT id
    FROM documents
    WHERE startup_id = ?
      AND type IN (${typePlaceholders})
      AND status IN ('DRAFT', 'SIGNED', 'LOCKED')
    `,
    [startupId, ...types]
  );

  if (!documentRows.length) {
    return;
  }

  const documentIds = documentRows.map((row) => Number(row.id)).filter(Number.isFinite);

  if (!documentIds.length) {
    return;
  }

  const idPlaceholders = documentIds.map(() => "?").join(", ");

  await db.query(
    `DELETE FROM document_signers WHERE document_id IN (${idPlaceholders})`,
    documentIds
  );

  await db.query(
    `
    DELETE FROM capital_decisions
    WHERE startup_id = ?
      AND (
        board_document_id IN (${idPlaceholders})
        OR gf_document_id IN (${idPlaceholders})
      )
    `,
    [startupId, ...documentIds, ...documentIds]
  );

  await db.query(
    `DELETE FROM documents WHERE id IN (${idPlaceholders})`,
    documentIds
  );
}
