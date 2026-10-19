import db from "../config/db.js";

/*
  The startup's investor pipeline.

  Raisium does not find investors. The startup invites people it already knows
  (friends and family, angels, investors in its own network), one named person
  per link. This module is the startup's view of where each of those people is:
  invited, opened the link, has access, signed, paid.

  Stages are derived from facts the system already records: the invite, the
  claim on it, and the RC agreement. There is no separate pipeline status that
  could drift away from what actually happened.
*/

export const INVITEE_RELATIONS = {
  venner_familie: "Venner og familie",
  engel: "Engelinvestor",
  investor: "Investor",
  nettverk: "Kollega eller nettverk",
  annet: "Annet"
};

export const DEFAULT_INVITEE_RELATION = "annet";

export const PIPELINE_STAGES = [
  { key: "invitert", label: "Invitert" },
  { key: "apnet", label: "Åpnet lenken" },
  { key: "registrert", label: "Har tilgang" },
  { key: "signering", label: "Venter på signatur" },
  { key: "betaling", label: "Venter på betaling" },
  { key: "aktiv", label: "Betalt" }
];

export const INVITEE_NAME_MIN_LENGTH = 2;
export const INVITEE_NAME_MAX_LENGTH = 120;

async function tableExists(connection, tableName) {
  const [rows] = await connection.query(
    `SELECT 1 FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1`,
    [tableName]
  );
  return rows.length > 0;
}

async function columnExists(connection, tableName, columnName) {
  const [rows] = await connection.query(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [tableName, columnName]
  );
  return rows.length > 0;
}

export async function ensureInvitePipelineSchema() {
  const connection = await db.getConnection();
  try {
    if (!(await tableExists(connection, "rc_invites"))) return;

    const columns = [
      ["invitee_name", "ALTER TABLE rc_invites ADD COLUMN invitee_name VARCHAR(120) NULL"],
      ["invitee_relation", "ALTER TABLE rc_invites ADD COLUMN invitee_relation VARCHAR(32) NULL"],
      ["first_opened_at", "ALTER TABLE rc_invites ADD COLUMN first_opened_at DATETIME NULL"]
    ];

    for (const [column, sql] of columns) {
      if (!(await columnExists(connection, "rc_invites", column))) {
        await connection.query(sql);
      }
    }
  } finally {
    connection.release();
  }
}

/*
  Every invite is for one named person. The name is what lets the startup keep
  track of who it has invited; it also keeps the link personal rather than
  something posted to a group.
*/
export function normalizeInviteeInput(body = {}) {
  const name = String(body.inviteeName ?? body.name ?? "")
    .replace(/\s+/g, " ")
    .trim();

  if (name.length < INVITEE_NAME_MIN_LENGTH) {
    return { ok: false, error: "Skriv inn navnet på personen du inviterer." };
  }
  if (name.length > INVITEE_NAME_MAX_LENGTH) {
    return { ok: false, error: `Navnet kan være maks ${INVITEE_NAME_MAX_LENGTH} tegn.` };
  }

  const rawRelation = String(body.relation || "").trim();
  const relation = Object.hasOwn(INVITEE_RELATIONS, rawRelation)
    ? rawRelation
    : DEFAULT_INVITEE_RELATION;

  return { ok: true, name, relation };
}

export function derivePipelineStage({ first_opened_at, claimed_by_user_id, agreement_status } = {}) {
  switch (String(agreement_status || "")) {
    case "Active RC": return "aktiv";
    case "Awaiting Payment": return "betaling";
    case "Pending Signatures": return "signering";
    case "Cancelled": return "avbrutt";
    default: break;
  }
  if (claimed_by_user_id != null) return "registrert";
  if (first_opened_at) return "apnet";
  return "invitert";
}

export function summarizePipeline(entries = []) {
  const counts = Object.fromEntries(PIPELINE_STAGES.map(({ key }) => [key, 0]));
  counts.avbrutt = 0;
  for (const entry of entries) {
    if (Object.hasOwn(counts, entry.stage)) counts[entry.stage] += 1;
  }
  return counts;
}

// Records the first time the invited person opened their link. Later visits
// leave the timestamp alone.
export async function markInviteOpened(connection, inviteId) {
  if (!inviteId) return;
  await connection.query(
    "UPDATE rc_invites SET first_opened_at = NOW() WHERE id = ? AND first_opened_at IS NULL",
    [inviteId]
  );
}

export async function findAgreementForClaimedInvite(connection, invite) {
  if (!invite?.claimed_by_user_id) return null;
  const [rows] = await connection.query(
    `SELECT id, status FROM rc_agreements
     WHERE round_id = ? AND investor_id = ?
     ORDER BY id DESC LIMIT 1`,
    [invite.round_id, invite.claimed_by_user_id]
  );
  return rows[0] || null;
}

export async function loadRoundPipeline(connection, roundId) {
  const [rows] = await connection.query(
    `
    SELECT
      i.id,
      i.token,
      i.invitee_name,
      i.invitee_relation,
      i.created_at,
      i.first_opened_at,
      i.claimed_by_user_id,
      i.claimed_at,
      u.name AS investor_name,
      a.id AS agreement_id,
      a.status AS agreement_status,
      a.investment_amount
    FROM rc_invites i
    LEFT JOIN users u ON u.id = i.claimed_by_user_id
    LEFT JOIN rc_agreements a ON a.id = (
      SELECT a2.id
      FROM rc_agreements a2
      WHERE a2.round_id = i.round_id
        AND a2.investor_id = i.claimed_by_user_id
      ORDER BY a2.id DESC
      LIMIT 1
    )
    WHERE i.round_id = ?
    ORDER BY i.created_at DESC, i.id DESC
    `,
    [roundId]
  );

  const entries = rows.map((row) => {
    const stage = derivePipelineStage(row);
    const claimed = row.claimed_by_user_id != null;
    return {
      id: row.id,
      inviteeName: row.invitee_name || row.investor_name || null,
      investorName: row.investor_name || null,
      relation: row.invitee_relation || null,
      relationLabel: row.invitee_relation ? INVITEE_RELATIONS[row.invitee_relation] || null : null,
      stage,
      createdAt: row.created_at,
      openedAt: row.first_opened_at,
      claimedAt: row.claimed_at,
      agreementId: row.agreement_id || null,
      investmentAmount: row.investment_amount == null ? null : Number(row.investment_amount),
      // Once someone has claimed the link it is theirs alone, so there is
      // nothing left for the startup to copy or send on.
      token: claimed ? null : row.token,
      canRevoke: !row.agreement_id
    };
  });

  return {
    stages: PIPELINE_STAGES,
    relations: INVITEE_RELATIONS,
    counts: summarizePipeline(entries),
    entries
  };
}
