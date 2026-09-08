import db from "../config/db.js";

const INDEXES = [
  ["document_signers", "idx_signers_user_pending_doc", "user_id, signed_at, document_id"],
  ["document_signers", "idx_signers_email_doc", "email, document_id"],
  ["documents", "idx_documents_startup_type_status_created", "startup_id, type, status, created_at"],
  ["rc_agreements", "idx_rc_round_status", "round_id, status"],
  ["rc_agreements", "idx_rc_investor_created_id", "investor_id, created_at, id"],
  ["emission_rounds", "idx_emission_startup_open_id", "startup_id, open, id"],
  ["startup_documents", "idx_startup_docs_type_uploaded", "startup_id, document_type, uploaded_at, id"],
  ["conversion_par_value_requests", "idx_par_agreement_id", "agreement_id, id"],
  ["startup_email_verifications", "idx_email_verification_active", "email, consumed_at, id"]
];

export async function ensurePerformanceIndexes() {
  const connection = await db.getConnection();
  try {
    for (const [table, indexName, columns] of INDEXES) {
      try {
        const [tables] = await connection.query(
          `SELECT 1 FROM information_schema.TABLES
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1`,
          [table]
        );
        if (!tables.length) continue;

        const [existing] = await connection.query(
          `SELECT 1 FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
          [table, indexName]
        );
        if (!existing.length) {
          await connection.query(`CREATE INDEX \`${indexName}\` ON \`${table}\` (${columns})`);
        }
      } catch (error) {
        // An optional performance index must never make the API unavailable.
        console.warn(`[db-index] ${table}.${indexName}:`, error?.message);
      }
    }
  } finally {
    connection.release();
  }
}
