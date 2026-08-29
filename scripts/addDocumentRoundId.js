import pool from "../config/db.js";

async function columnExists(table, column) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS count FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return rows[0].count > 0;
}

async function run() {
  console.log("Checking documents.round_id column...");

  if (await columnExists("documents", "round_id")) {
    console.log("Column already exists, skipping ALTER TABLE.");
  } else {
    console.log("Adding round_id column to documents...");
    await pool.query(`ALTER TABLE documents ADD COLUMN round_id INT NULL AFTER startup_id`);
    await pool.query(
      `ALTER TABLE documents ADD CONSTRAINT fk_documents_round
       FOREIGN KEY (round_id) REFERENCES emission_rounds(id) ON DELETE SET NULL`
    );
    console.log("Column + FK added.");
  }

  console.log("\nBackfilling RC agreement documents via html_content...");
  const [rcDocs] = await pool.query(
    `SELECT id, html_content FROM documents WHERE type = 'RC' AND round_id IS NULL`
  );
  let rcLinked = 0;
  for (const doc of rcDocs) {
    const match = String(doc.html_content || "").match(/rc_agreement_id:(\d+)/i);
    if (!match) continue;
    const [agreementRows] = await pool.query(
      `SELECT round_id FROM rc_agreements WHERE id = ? LIMIT 1`,
      [match[1]]
    );
    if (agreementRows.length) {
      await pool.query(`UPDATE documents SET round_id = ? WHERE id = ?`, [agreementRows[0].round_id, doc.id]);
      rcLinked++;
    }
  }
  console.log(`Linked ${rcLinked}/${rcDocs.length} RC documents.`);

  console.log("\nBackfilling conversion documents via conversion_events...");
  const [conversionResult] = await pool.query(`
    UPDATE documents d
    JOIN conversion_events ce
      ON d.id = ce.board_document_id
      OR d.id = ce.gf_document_id
      OR d.id = ce.updated_articles_document_id
      OR d.id = ce.shareholder_register_document_id
      OR d.id = ce.capital_confirmation_document_id
      OR d.id = ce.altinn_package_document_id
    SET d.round_id = ce.round_id
    WHERE d.round_id IS NULL
  `);
  console.log(`Linked ${conversionResult.affectedRows} conversion documents.`);

  console.log("\nBackfilling pre-round BOARD/GF documents (best-effort: nearest following round per startup)...");
  const [boardGfDocs] = await pool.query(
    `SELECT id, startup_id, created_at FROM documents WHERE type IN ('BOARD', 'GF') AND round_id IS NULL ORDER BY created_at ASC`
  );
  let boardGfLinked = 0;
  for (const doc of boardGfDocs) {
    const [roundRows] = await pool.query(
      `SELECT id FROM emission_rounds WHERE startup_id = ? AND created_at >= ? ORDER BY created_at ASC LIMIT 1`,
      [doc.startup_id, doc.created_at]
    );
    if (roundRows.length) {
      await pool.query(`UPDATE documents SET round_id = ? WHERE id = ?`, [roundRows[0].id, doc.id]);
      boardGfLinked++;
    }
  }
  console.log(`Linked ${boardGfLinked}/${boardGfDocs.length} BOARD/GF documents.`);

  const [remaining] = await pool.query(`SELECT COUNT(*) AS count FROM documents WHERE round_id IS NULL`);
  console.log(`\nDone. ${remaining[0].count} documents remain without a round_id (expected for BOARD/GF docs with no round created yet).`);

  process.exit(0);
}

run().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
