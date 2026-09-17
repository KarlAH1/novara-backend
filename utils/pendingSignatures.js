import { getLegalResetCutoff } from "./legalRoundReset.js";

/*
  The documents a user still has to sign.

  Shared by /auth/pending-signatures and the "Neste oppgave" card, so the two
  can never disagree. Three rules keep the list honest:

    - Only the newest unsigned document of each kind per company is shown. A
      regenerated board proposal supersedes the earlier one; listing both asks
      the user to sign the same thing twice.
    - Year-0 documents left over from a round that has since been completed are
      not "waiting" for anything and are skipped.
    - The sign link carries the document's real type, so the signing page shows
      the right context for a board proposal, a GF protocol or an RC.
*/

const SIGN_TYPE_BY_DOCUMENT_TYPE = {
  BOARD: "board",
  GF: "gf",
  RC: "rc",
  SFC: "board",
  GFC: "gf"
};

// Year-0 documents belong to one round's setup and go stale once it completes.
const YEAR_ZERO_TYPES = new Set(["BOARD", "GF"]);

export function signTypeFor(documentType) {
  return SIGN_TYPE_BY_DOCUMENT_TYPE[String(documentType || "").toUpperCase()] || "conversion";
}

export async function getPendingSignatures(connection, userId) {
  const [rows] = await connection.query(
    `SELECT ds.id AS signer_id, ds.document_id, ds.role, d.title, d.type,
            d.startup_id, d.round_id, d.created_at,
            COALESCE(sp.company_name, startup.name) AS company_name
     FROM document_signers ds
     JOIN documents d ON d.id = ds.document_id
     LEFT JOIN users startup ON startup.id = d.startup_id
     LEFT JOIN startup_profiles sp ON sp.user_id = d.startup_id
     WHERE ds.user_id = ? AND ds.signed_at IS NULL AND d.status != 'LOCKED'
     ORDER BY d.created_at DESC, d.id DESC`,
    [userId]
  );

  const cutoffByStartup = new Map();
  const seen = new Set();
  const pending = [];

  for (const row of rows) {
    const type = String(row.type || "").toUpperCase();

    if (YEAR_ZERO_TYPES.has(type)) {
      if (!cutoffByStartup.has(row.startup_id)) {
        cutoffByStartup.set(row.startup_id, await getLegalResetCutoff(connection, row.startup_id));
      }
      const cutoff = cutoffByStartup.get(row.startup_id);
      if (cutoff && new Date(row.created_at) <= new Date(cutoff)) continue;
    }

    // RC agreements are individual — each is its own item. Company documents
    // collapse to the newest one of their kind.
    const key = type === "RC" ? `RC:${row.document_id}` : `${row.startup_id}:${type}`;
    if (seen.has(key)) continue;
    seen.add(key);

    pending.push({
      signer_id: row.signer_id,
      document_id: row.document_id,
      document_title: row.title,
      document_type: row.type,
      startup_id: row.startup_id,
      round_id: row.round_id,
      company_name: row.company_name,
      role: row.role,
      sign_path: `sign.html?type=${signTypeFor(type)}&id=${row.document_id}`
    });
  }

  return pending;
}
