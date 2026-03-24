export async function getCompanyForUserWithConnection(connection, userId) {
  const [rows] = await connection.query(
    `
    SELECT c.id AS company_id, c.company_name, c.orgnr
    FROM company_memberships cm
    JOIN companies c ON c.id = cm.company_id
    WHERE cm.user_id = ?
    LIMIT 1
    `,
    [userId]
  );

  return rows[0] || null;
}

export async function getCompanyStartupProfile(connection, userId) {
  const company = await getCompanyForUserWithConnection(connection, userId);

  if (!company?.company_id) {
    return null;
  }

  const [rows] = await connection.query(
    `
    SELECT sp.*
    FROM startup_profiles sp
    JOIN company_memberships cm ON cm.user_id = sp.user_id
    WHERE cm.company_id = ?
    ORDER BY sp.id DESC
    LIMIT 1
    `,
    [company.company_id]
  );

  return rows[0] || null;
}

async function findSharedStartupUserId(connection, companyId, query, params = []) {
  const [rows] = await connection.query(query, [companyId, ...params]);
  return rows[0]?.startup_id || rows[0]?.user_id || null;
}

export async function resolveCompanyStartupOwner(connection, userId) {
  const company = await getCompanyForUserWithConnection(connection, userId);

  if (!company?.company_id) {
    return {
      company: null,
      startupUserId: userId
    };
  }

  const startupUserId =
    await findSharedStartupUserId(
      connection,
      company.company_id,
      `
      SELECT e.startup_id
      FROM emission_rounds e
      JOIN company_memberships cm ON cm.user_id = e.startup_id
      WHERE cm.company_id = ?
      ORDER BY e.id DESC
      LIMIT 1
      `
    ) ||
    await findSharedStartupUserId(
      connection,
      company.company_id,
      `
      SELECT d.startup_id
      FROM documents d
      JOIN company_memberships cm ON cm.user_id = d.startup_id
      WHERE cm.company_id = ?
        AND d.type IN ('BOARD', 'GF')
      ORDER BY d.id DESC
      LIMIT 1
      `
    ) ||
    await findSharedStartupUserId(
      connection,
      company.company_id,
      `
      SELECT s.startup_id
      FROM startup_legal_data s
      JOIN company_memberships cm ON cm.user_id = s.startup_id
      WHERE cm.company_id = ?
      ORDER BY s.created_at DESC
      LIMIT 1
      `
    ) ||
    await findSharedStartupUserId(
      connection,
      company.company_id,
      `
      SELECT sp.user_id
      FROM startup_profiles sp
      JOIN company_memberships cm ON cm.user_id = sp.user_id
      WHERE cm.company_id = ?
      ORDER BY sp.id DESC
      LIMIT 1
      `
    ) ||
    userId;

  return {
    company,
    startupUserId: Number(startupUserId)
  };
}

export async function isUserInSameCompany(connection, userId, targetUserId) {
  const [rows] = await connection.query(
    `
    SELECT 1
    FROM company_memberships source_cm
    JOIN company_memberships target_cm ON target_cm.company_id = source_cm.company_id
    WHERE source_cm.user_id = ?
      AND target_cm.user_id = ?
    LIMIT 1
    `,
    [userId, targetUserId]
  );

  return rows.length > 0;
}
