import db from "../config/db.js";
import { fetchBrregRoles } from "./brreg.js";

/*
  Who signs the board proposal for a conversion.

  Previously the logged-in user was written into the document as "Styreleder"
  with nothing checking whether they hold that office. That asserts a statutory
  role the platform never verified, and if the company's chair is someone else
  the document names one person while the signature block records another.

  So the chair is resolved from Brønnøysund, shown to the company, and
  explicitly confirmed by a person before any conversion document is generated.
  The confirmation is snapshotted, and the same snapshot feeds both the body of
  the document and the signature block — one identity, one source.
*/

const CHAIR_ROLE_PATTERNS = [/styrets\s+leder/i, /styreleder/i, /\bleder\b/i];

async function tableExists(connection, tableName) {
  const [rows] = await connection.query(
    `SELECT 1 FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1`,
    [tableName]
  );
  return rows.length > 0;
}

export async function ensureBoardRoleSchema() {
  const connection = await db.getConnection();
  try {
    if (await tableExists(connection, "conversion_board_roles")) return;

    await connection.query(`
      CREATE TABLE conversion_board_roles (
        id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        conversion_event_id INT NOT NULL,
        startup_id INT NOT NULL,
        role VARCHAR(32) NOT NULL,
        person_name VARCHAR(255) NOT NULL,
        person_email VARCHAR(255) NULL,
        person_user_id INT NULL,
        source VARCHAR(32) NOT NULL,
        confirmed_by INT NOT NULL,
        confirmed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_conversion_role (conversion_event_id, role),
        INDEX idx_conversion_board_role_startup (startup_id)
      )
    `);
  } finally {
    connection.release();
  }
}

export function normalizePersonName(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/*
  Suggests the chair from Brønnøysund. A suggestion only — it prefills the UI
  and never itself authorises anyone to sign.
*/
export async function suggestBoardChair(orgnr) {
  if (!orgnr) return { candidates: [], suggested: null, source: "none" };

  let roles = [];
  try {
    roles = await fetchBrregRoles(orgnr);
  } catch {
    return { candidates: [], suggested: null, source: "brreg_unavailable" };
  }

  const chairs = roles.filter((entry) =>
    CHAIR_ROLE_PATTERNS.some((pattern) => pattern.test(entry.role || ""))
  );

  return {
    candidates: roles.map((entry) => ({ name: entry.name, role: entry.role })),
    // Only auto-suggest when Brønnøysund names exactly one chair. Two or more
    // is ambiguous, and guessing between them is how the wrong person ends up
    // signing.
    suggested: chairs.length === 1 ? { name: chairs[0].name, role: chairs[0].role } : null,
    source: chairs.length === 1 ? "brreg" : (chairs.length ? "brreg_ambiguous" : "brreg_no_chair")
  };
}

export async function getConfirmedBoardRole(connection, conversionEventId, role = "board_chair") {
  if (!(await tableExists(connection, "conversion_board_roles"))) return null;

  const [rows] = await connection.query(
    `SELECT * FROM conversion_board_roles WHERE conversion_event_id = ? AND role = ? LIMIT 1`,
    [conversionEventId, role]
  );
  return rows[0] || null;
}

export async function confirmBoardRole(connection, {
  conversionEventId, startupId, role = "board_chair",
  personName, personEmail = null, personUserId = null,
  source = "manual", confirmedBy
}) {
  const name = String(personName || "").trim();
  if (!name) return { ok: false, error: "Navn på styreleder må fylles ut." };
  if (!confirmedBy) return { ok: false, error: "Bekreftelsen mangler bruker." };
  if (!(await tableExists(connection, "conversion_board_roles"))) {
    return { ok: false, error: "Rollebekreftelse er ikke tilgjengelig." };
  }

  await connection.query(
    `INSERT INTO conversion_board_roles
     (conversion_event_id, startup_id, role, person_name, person_email, person_user_id, source, confirmed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       person_name = VALUES(person_name),
       person_email = VALUES(person_email),
       person_user_id = VALUES(person_user_id),
       source = VALUES(source),
       confirmed_by = VALUES(confirmed_by),
       confirmed_at = NOW()`,
    [conversionEventId, startupId, role, name, personEmail, personUserId, source, confirmedBy]
  );

  return { ok: true, personName: name };
}

/*
  Guards document generation. The board proposal cannot be produced until a
  person has confirmed who the chair is — otherwise the document would assert
  an office nobody verified.
*/
export async function requireConfirmedChair(connection, conversionEventId) {
  const confirmed = await getConfirmedBoardRole(connection, conversionEventId, "board_chair");

  if (!confirmed?.person_name) {
    return {
      ok: false,
      error:
        "Styreleder må bekreftes før styrets forslag kan genereres. " +
        "Åpne konverteringen, kontroller forslaget fra Brønnøysund, og bekreft hvem som er styreleder."
    };
  }

  return { ok: true, chair: confirmed };
}

/*
  The body of a document and its signature block must name the same person.
  Called before locking so a mismatch stops the document rather than being
  discovered in Brønnøysund.
*/
export function assertSignerMatchesBody(bodyPersonName, signerPersonName) {
  const body = normalizePersonName(bodyPersonName);
  const signer = normalizePersonName(signerPersonName);

  if (!body || !signer) {
    return { ok: false, error: "Rollen er ikke entydig fastsatt for dokumentet." };
  }
  if (body !== signer) {
    return {
      ok: false,
      error: `Dokumentet oppgir «${bodyPersonName}», men signaturfeltet er «${signerPersonName}». Dokumentet ble ikke låst.`
    };
  }
  return { ok: true };
}
