export const ensureCompanyAndMembership = async (connection, { userId, orgnr, companyName }) => {
  const [companyRows] = await connection.query(
    "SELECT id FROM companies WHERE orgnr = ? LIMIT 1",
    [orgnr]
  );

  let companyId = companyRows[0]?.id;

  if (!companyId) {
    const [insertResult] = await connection.query(
      "INSERT INTO companies (orgnr, company_name) VALUES (?, ?)",
      [orgnr, companyName]
    );
    companyId = insertResult.insertId;
  } else {
    await connection.query(
      "UPDATE companies SET company_name = ? WHERE id = ?",
      [companyName, companyId]
    );
  }

  await connection.query(
    "DELETE FROM company_memberships WHERE user_id = ? AND company_id <> ?",
    [userId, companyId]
  );

  await connection.query(
    `
    INSERT INTO company_memberships (company_id, user_id)
    VALUES (?, ?)
    ON DUPLICATE KEY UPDATE company_id = VALUES(company_id)
    `,
    [companyId, userId]
  );

  return companyId;
};
