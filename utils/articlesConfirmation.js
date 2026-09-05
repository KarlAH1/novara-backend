import db from "../config/db.js";

/*
  Human confirmation of the company's share basis.

  A parser reading a PDF, and a language model filling in what the parser
  missed, are both useful and neither is legal truth. The share capital, the
  share count and the par value decide the share price, every investor's
  allocation and the size of the later capital increase — so before a round can
  go live, a person at the company has to look at those three numbers and say
  they match the company's current articles.

  What is stored is the confirmation itself: who confirmed, when, which values,
  where each value came from, which parser and which model produced it, and
  which uploaded document it was read from. That record is what makes a later
  dispute about "where did this number come from" answerable.
*/

async function tableExists(connection, tableName) {
  const [rows] = await connection.query(
    `SELECT 1 FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1`,
    [tableName]
  );
  return rows.length > 0;
}

export async function ensureArticlesConfirmationSchema() {
  const connection = await db.getConnection();
  try {
    if (await tableExists(connection, "startup_articles_confirmations")) return;

    await connection.query(`
      CREATE TABLE startup_articles_confirmations (
        id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        startup_id INT NOT NULL,
        document_id INT NULL,
        share_capital_amount DECIMAL(18,2) NOT NULL,
        share_count INT NOT NULL,
        par_value_per_share DECIMAL(12,4) NOT NULL,
        source VARCHAR(32) NOT NULL,
        parser_version VARCHAR(64) NULL,
        ai_model VARCHAR(64) NULL,
        ai_extraction_version VARCHAR(64) NULL,
        document_hash VARCHAR(128) NULL,
        confirmed_by INT NOT NULL,
        confirmed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        superseded_at DATETIME NULL,
        INDEX idx_articles_confirmation_startup (startup_id),
        INDEX idx_articles_confirmation_active (startup_id, superseded_at)
      )
    `);
  } finally {
    connection.release();
  }
}

/*
  share_capital = share_count x par_value, for a company with a single uniform
  par value. A mismatch means one of the three is wrong; guessing which would
  produce a wrong share price and a wrong capital increase, so it is refused.
*/
export function checkShareBasisConsistency({ shareCapital, shareCount, parValue }) {
  const capital = Number(shareCapital);
  const count = Number(shareCount);
  const par = Number(parValue);

  if (!Number.isFinite(capital) || capital <= 0) return { ok: false, error: "Aksjekapitalen mangler eller er ikke et gyldig beløp." };
  if (!Number.isFinite(count) || count <= 0 || !Number.isInteger(count)) return { ok: false, error: "Antall aksjer mangler eller er ikke et helt tall større enn null." };
  if (!Number.isFinite(par) || par <= 0) return { ok: false, error: "Pålydende per aksje mangler eller er ikke et gyldig beløp." };

  const expected = Math.round(count * par * 100) / 100;
  if (Math.abs(expected - capital) > 0.5) {
    return {
      ok: false,
      error:
        `Tallene henger ikke sammen: ${count} aksjer × ${par} i pålydende gir ${expected}, ` +
        `men aksjekapitalen er oppgitt til ${capital}. Kontroller mot gjeldende vedtekter og rett opp.`
    };
  }

  return { ok: true };
}

export async function getActiveArticlesConfirmation(connection, startupId) {
  if (!(await tableExists(connection, "startup_articles_confirmations"))) return null;

  const [rows] = await connection.query(
    `SELECT * FROM startup_articles_confirmations
     WHERE startup_id = ? AND superseded_at IS NULL
     ORDER BY confirmed_at DESC, id DESC LIMIT 1`,
    [startupId]
  );
  return rows[0] || null;
}

/*
  Records a confirmation. Any earlier one is superseded rather than deleted, so
  the history of what was confirmed when survives.
*/
export async function recordArticlesConfirmation(connection, {
  startupId, documentId, shareCapital, shareCount, parValue,
  source, parserVersion, aiModel, aiExtractionVersion, documentHash, confirmedBy
}) {
  const consistency = checkShareBasisConsistency({ shareCapital, shareCount, parValue });
  if (!consistency.ok) return { ok: false, error: consistency.error };

  await connection.query(
    `UPDATE startup_articles_confirmations
     SET superseded_at = NOW()
     WHERE startup_id = ? AND superseded_at IS NULL`,
    [startupId]
  );

  const [result] = await connection.query(
    `INSERT INTO startup_articles_confirmations
     (startup_id, document_id, share_capital_amount, share_count, par_value_per_share,
      source, parser_version, ai_model, ai_extraction_version, document_hash, confirmed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      startupId, documentId || null, Number(shareCapital), Number(shareCount), Number(parValue),
      source || "manual", parserVersion || null, aiModel || null,
      aiExtractionVersion || null, documentHash || null, confirmedBy
    ]
  );

  return { ok: true, id: result.insertId };
}

/*
  A confirmation only covers the numbers it was given. If the company later
  edits its share basis, the confirmation no longer describes what the system
  holds and the company has to look at it again.
*/
export function confirmationMatches(confirmation, { shareCapital, shareCount, parValue }) {
  if (!confirmation) return false;
  const near = (a, b, tolerance) => Math.abs(Number(a) - Number(b)) <= tolerance;
  return (
    near(confirmation.share_capital_amount, shareCapital, 0.5) &&
    Number(confirmation.share_count) === Number(shareCount) &&
    near(confirmation.par_value_per_share, parValue, 0.0001)
  );
}
