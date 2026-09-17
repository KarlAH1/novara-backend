import { MINIMUM_RC_INVESTMENT_NOK } from "./rcInvestmentRules.js";

const INVESTOR_FLOW_STAGES = new Set(["terms", "invest", "review"]);

export function normalizeInvestorFlowProgress(input = {}) {
  const stage = INVESTOR_FLOW_STAGES.has(input.stage) ? input.stage : "terms";
  const parsedAmount = Number(input.amount);
  const amount = Number.isFinite(parsedAmount) && parsedAmount > 0
    ? Math.round(parsedAmount)
    : null;
  return { stage, amount };
}

function mapProgressRow(row) {
  if (!row) return null;
  return {
    inviteId: Number(row.invite_id),
    roundId: Number(row.round_id),
    stage: INVESTOR_FLOW_STAGES.has(row.stage) ? row.stage : "terms",
    amount: row.amount == null ? null : Number(row.amount),
    updatedAt: row.updated_at || null,
    inviteToken: row.invite_token || null,
    companyName: row.company_name || null
  };
}

export async function loadInvestorFlowProgress(connection, { investorId, inviteId }) {
  const [rows] = await connection.query(
    `SELECT p.invite_id, i.round_id, p.stage, p.amount, p.updated_at
     FROM investor_flow_progress p
     JOIN rc_invites i ON i.id = p.invite_id
     WHERE p.investor_id = ? AND p.invite_id = ?
     LIMIT 1`,
    [investorId, inviteId]
  );
  return mapProgressRow(rows[0]);
}

export async function saveInvestorFlowProgress(connection, { investorId, inviteId, progress }) {
  const normalized = normalizeInvestorFlowProgress(progress);
  await connection.query(
    `INSERT INTO investor_flow_progress
       (investor_id, invite_id, stage, amount, updated_at)
     VALUES (?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       stage = VALUES(stage),
       amount = VALUES(amount),
       updated_at = NOW()`,
    [investorId, inviteId, normalized.stage, normalized.amount]
  );
  return loadInvestorFlowProgress(connection, { investorId, inviteId });
}

export async function deleteInvestorFlowProgress(connection, { investorId, inviteId }) {
  await connection.query(
    "DELETE FROM investor_flow_progress WHERE investor_id = ? AND invite_id = ?",
    [investorId, inviteId]
  );
}

export async function deleteInvestorFlowProgressForRound(connection, roundId) {
  await connection.query(
    `DELETE p FROM investor_flow_progress p
     JOIN rc_invites i ON i.id = p.invite_id
     WHERE i.round_id = ?`,
    [roundId]
  );
}

export async function getInvestorFlowProgressList(connection, investorId) {
  const [rows] = await connection.query(
    `SELECT p.invite_id, i.round_id, i.token AS invite_token,
            p.stage, p.amount, p.updated_at,
            COALESCE(c.company_name, sp.company_name, startup.name) AS company_name
     FROM investor_flow_progress p
     JOIN rc_invites i ON i.id = p.invite_id
     JOIN emission_rounds r ON r.id = i.round_id
     JOIN users startup ON startup.id = r.startup_id
     LEFT JOIN company_memberships cm ON cm.user_id = r.startup_id
     LEFT JOIN companies c ON c.id = cm.company_id
     LEFT JOIN startup_profiles sp ON sp.user_id = r.startup_id
     WHERE p.investor_id = ?
       AND i.claimed_by_user_id = p.investor_id
       AND r.open = 1
       AND (r.closed_reason IS NULL OR r.closed_reason = '')
       AND (r.deadline IS NULL OR r.deadline >= NOW())
       AND r.target_amount - COALESCE(r.committed_amount, r.amount_raised, 0) >= ?
       AND NOT EXISTS (
         SELECT 1 FROM rc_agreements a
         WHERE a.round_id = i.round_id AND a.investor_id = p.investor_id
       )
     ORDER BY p.updated_at DESC`,
    [investorId, MINIMUM_RC_INVESTMENT_NOK]
  );
  return rows.map(mapProgressRow);
}

export async function getLatestInvestorFlowProgress(connection, investorId) {
  const [latest] = await getInvestorFlowProgressList(connection, investorId);
  return latest || null;
}
