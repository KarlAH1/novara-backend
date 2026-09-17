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

/*
  Removes earlier UNSIGNED drafts of a year-0 legal document before a new one is
  generated.

  Generating "Styrets forslag" or the GF protocol again used to add another
  document every time, while the old, never-signed drafts stayed behind with
  open signer rows. Each of them then showed up as "venter på din signatur" —
  three identical board proposals for one round.

  Only drafts nobody has signed are removed. A draft that carries even one
  signature is left alone, and SIGNED/LOCKED documents are never touched here:
  those are evidence, and the generating routes already refuse to replace them.
*/
export async function removeUnsignedDrafts(db, startupId, type) {
  const [rows] = await db.query(
    `
    SELECT d.id
    FROM documents d
    WHERE d.startup_id = ?
      AND d.type = ?
      AND d.status = 'DRAFT'
      AND NOT EXISTS (
        SELECT 1 FROM document_signers ds
        WHERE ds.document_id = d.id AND ds.signed_at IS NOT NULL
      )
    `,
    [startupId, type]
  );

  const ids = rows.map((row) => Number(row.id)).filter(Number.isFinite);
  if (!ids.length) return 0;

  const placeholders = ids.map(() => "?").join(", ");

  await db.query(`DELETE FROM document_signers WHERE document_id IN (${placeholders})`, ids);
  await db.query(
    `
    DELETE FROM capital_decisions
    WHERE startup_id = ?
      AND (board_document_id IN (${placeholders}) OR gf_document_id IN (${placeholders}))
    `,
    [startupId, ...ids, ...ids]
  );
  await db.query(`DELETE FROM documents WHERE id IN (${placeholders})`, ids);

  return ids.length;
}
