import jwt from "jsonwebtoken";

/*
  Invite links are single-use in the sense that matters: the first investor who
  actually uses one binds it to their account. After that, only that account can
  open it — a forwarded link is dead to everyone else. The legitimate investor
  can still return to their own link (reload, come back later, finish signing),
  which a literal "one HTTP request and it's gone" rule would break.
*/

export async function loadInviteClaim(connection, token) {
  const [rows] = await connection.query(
    `SELECT id, round_id, claimed_by_user_id FROM rc_invites WHERE token = ? LIMIT 1`,
    [token]
  );
  return rows[0] || null;
}

// Reads the caller's identity from the Authorization header when present.
// The invite endpoints are reachable before login, so this must not throw.
export function getOptionalUserFromRequest(req) {
  const header = String(req.headers?.authorization || "");
  if (!header.startsWith("Bearer ")) {
    return null;
  }

  try {
    return jwt.verify(header.slice(7).trim(), process.env.JWT_SECRET);
  } catch {
    return null;
  }
}

export function inviteIsAvailableTo(invite, userId) {
  if (!invite) return false;
  if (invite.claimed_by_user_id == null) return true;
  return Number(invite.claimed_by_user_id) === Number(userId);
}

// Binds an unclaimed invite to this user. Returns false when the invite was
// already taken by someone else (checked inside the UPDATE so two people
// racing on the same link can't both win).
export async function claimInviteForUser(connection, token, userId) {
  const [result] = await connection.query(
    `
    UPDATE rc_invites
    SET claimed_by_user_id = ?, claimed_at = NOW()
    WHERE token = ?
      AND (claimed_by_user_id IS NULL OR claimed_by_user_id = ?)
    `,
    [userId, token, userId]
  );

  return result.affectedRows > 0;
}

export const INVITE_TAKEN_ERROR =
  "Denne invitasjonen er allerede i bruk av en annen investor. Be selskapet om din egen lenke.";
