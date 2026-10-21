import db from "../config/db.js";

/*
  Founder updates: short posts from the company to the people who have
  invested in it. Private by construction. An update belongs to a company,
  and only investors with a signed agreement in one of that company's rounds
  can read it. There is no public view.
*/

export const UPDATE_TITLE_MAX_LENGTH = 120;
export const UPDATE_BODY_MAX_LENGTH = 2000;

// Investors who have signed count; a withdrawn or cancelled agreement does not.
export const UPDATE_READER_STATUSES = ["Awaiting Payment", "Active RC"];

export async function ensureStartupUpdateSchema() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS startup_updates (
      id INT AUTO_INCREMENT PRIMARY KEY,
      company_id INT NOT NULL,
      author_user_id INT NOT NULL,
      title VARCHAR(${UPDATE_TITLE_MAX_LENGTH}) NOT NULL,
      body TEXT NOT NULL,
      emailed_at DATETIME NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_startup_updates_company (company_id, created_at)
    )
  `);
}

export function normalizeUpdateInput(body = {}) {
  const title = String(body.title || "").replace(/\s+/g, " ").trim();
  const text = String(body.body || "").replace(/\r\n/g, "\n").trim();
  if (title.length < 2) return { ok: false, error: "Skriv en kort overskrift." };
  if (title.length > UPDATE_TITLE_MAX_LENGTH) {
    return { ok: false, error: `Overskriften kan være maks ${UPDATE_TITLE_MAX_LENGTH} tegn.` };
  }
  if (text.length < 2) return { ok: false, error: "Skriv hva som har skjedd." };
  if (text.length > UPDATE_BODY_MAX_LENGTH) {
    return { ok: false, error: `Oppdateringen kan være maks ${UPDATE_BODY_MAX_LENGTH} tegn.` };
  }
  return { ok: true, title, body: text, sendEmail: body.sendEmail !== false };
}

export async function findCompanyForUser(connection, userId) {
  const [[row]] = await connection.query(
    `SELECT c.id, c.company_name
     FROM company_memberships cm
     JOIN companies c ON c.id = cm.company_id
     WHERE cm.user_id = ? LIMIT 1`,
    [userId]
  );
  return row || null;
}

// Everyone who may read the company's updates, one row per person.
export async function loadUpdateReaders(connection, companyId) {
  const [rows] = await connection.query(
    `SELECT DISTINCT inv.id, inv.name, inv.email
     FROM rc_agreements a
     JOIN company_memberships cm ON cm.user_id = a.startup_id
     JOIN users inv ON inv.id = a.investor_id
     WHERE cm.company_id = ?
       AND a.status IN (?)`,
    [companyId, UPDATE_READER_STATUSES]
  );
  return rows;
}

export async function loadInvestorFeed(connection, investorId, { limit = 50 } = {}) {
  const [rows] = await connection.query(
    `SELECT u.id, u.title, u.body, u.created_at, u.company_id, c.company_name,
            author.name AS author_name
     FROM startup_updates u
     JOIN companies c ON c.id = u.company_id
     JOIN users author ON author.id = u.author_user_id
     WHERE u.company_id IN (
       SELECT cm.company_id
       FROM rc_agreements a
       JOIN company_memberships cm ON cm.user_id = a.startup_id
       WHERE a.investor_id = ? AND a.status IN (?)
     )
     ORDER BY u.created_at DESC, u.id DESC
     LIMIT ?`,
    [investorId, UPDATE_READER_STATUSES, Number(limit)]
  );
  return rows;
}
