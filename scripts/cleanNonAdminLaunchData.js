import "../config/env.js";
import mysql from "mysql2/promise";

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false
});

async function main() {
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const [nonAdminRows] = await conn.query(
      "SELECT id FROM users WHERE role <> 'admin'"
    );
    const nonAdminIds = nonAdminRows
      .map((row) => Number(row.id))
      .filter(Boolean);

    const [[beforeUsers]] = await conn.query(
      "SELECT COUNT(*) AS count FROM users WHERE role <> 'admin'"
    );
    const [[beforeStartups]] = await conn.query(
      "SELECT COUNT(*) AS count FROM startup_profiles"
    );
    const [[beforeRounds]] = await conn.query(
      "SELECT COUNT(*) AS count FROM emission_rounds"
    );
    const [[beforeCompanies]] = await conn.query(
      "SELECT COUNT(*) AS count FROM companies"
    );

    if (nonAdminIds.length) {
      const placeholders = nonAdminIds.map(() => "?").join(", ");
      const [roundRows] = await conn.query(
        `SELECT id FROM emission_rounds WHERE startup_id IN (${placeholders})`,
        nonAdminIds
      );
      const roundIds = roundRows
        .map((row) => Number(row.id))
        .filter(Boolean);

      await conn.query(
        `DELETE FROM activity_log WHERE user_id IN (${placeholders})`,
        nonAdminIds
      );
      await conn.query(
        `DELETE FROM notifications WHERE user_id IN (${placeholders})`,
        nonAdminIds
      );
      await conn.query(
        `DELETE FROM investor_profiles WHERE user_id IN (${placeholders})`,
        nonAdminIds
      );
      await conn.query(
        `DELETE FROM investor_interest WHERE investor_id IN (${placeholders}) OR startup_id IN (${placeholders})`,
        [...nonAdminIds, ...nonAdminIds]
      );
      await conn.query(
        `DELETE FROM slip_agreements WHERE investor_id IN (${placeholders}) OR startup_id IN (${placeholders})`,
        [...nonAdminIds, ...nonAdminIds]
      );
      await conn.query(
        `DELETE FROM document_signers WHERE user_id IN (${placeholders})`,
        nonAdminIds
      );
      await conn.query(
        `DELETE ds
         FROM document_signers ds
         INNER JOIN documents d ON d.id = ds.document_id
         WHERE d.startup_id IN (${placeholders})`,
        nonAdminIds
      );
      await conn.query(
        `DELETE FROM startup_documents WHERE startup_id IN (${placeholders})`,
        nonAdminIds
      );
      await conn.query(
        `DELETE FROM startup_legal_data WHERE startup_id IN (${placeholders})`,
        nonAdminIds
      );
      await conn.query(
        `DELETE FROM capital_decisions WHERE startup_id IN (${placeholders})`,
        nonAdminIds
      );
      await conn.query(
        `DELETE FROM documents WHERE startup_id IN (${placeholders})`,
        nonAdminIds
      );
      await conn.query(
        `DELETE FROM conversion_events WHERE startup_id IN (${placeholders})`,
        nonAdminIds
      );
      await conn.query(
        `DELETE FROM startup_profiles WHERE user_id IN (${placeholders})`,
        nonAdminIds
      );
      await conn.query(
        `DELETE FROM rc_rounds WHERE startup_id IN (${placeholders})`,
        nonAdminIds
      );

      if (roundIds.length) {
        const roundPlaceholders = roundIds.map(() => "?").join(", ");
        await conn.query(
          `DELETE FROM rc_invites WHERE round_id IN (${roundPlaceholders})`,
          roundIds
        );
        await conn.query(
          `DELETE FROM emission_invites WHERE emission_id IN (${roundPlaceholders})`,
          roundIds
        );
        await conn.query(
          `DELETE FROM emission_shareholders WHERE emission_id IN (${roundPlaceholders})`,
          roundIds
        );
        await conn.query(
          `DELETE FROM admin_issues WHERE emission_id IN (${roundPlaceholders})`,
          roundIds
        );
      }

      const [companyRows] = await conn.query(
        `SELECT DISTINCT company_id FROM company_memberships WHERE user_id IN (${placeholders})`,
        nonAdminIds
      );
      const companyIds = companyRows
        .map((row) => Number(row.company_id))
        .filter(Boolean);

      if (companyIds.length) {
        const companyPlaceholders = companyIds.map(() => "?").join(", ");
        await conn.query(
          `DELETE FROM startup_discount_redemptions WHERE user_id IN (${placeholders}) OR company_id IN (${companyPlaceholders})`,
          [...nonAdminIds, ...companyIds]
        );
        await conn.query(
          `DELETE FROM startup_plan_subscriptions WHERE user_id IN (${placeholders}) OR company_id IN (${companyPlaceholders})`,
          [...nonAdminIds, ...companyIds]
        );
      }

      await conn.query(
        `DELETE FROM company_memberships WHERE user_id IN (${placeholders})`,
        nonAdminIds
      );

      await conn.query(
        `DELETE FROM users WHERE id IN (${placeholders})`,
        nonAdminIds
      );
      await conn.query(
        "DELETE FROM companies WHERE id NOT IN (SELECT DISTINCT company_id FROM company_memberships)"
      );
    }

    const [[afterUsers]] = await conn.query(
      "SELECT COUNT(*) AS count FROM users WHERE role <> 'admin'"
    );
    const [[afterStartups]] = await conn.query(
      "SELECT COUNT(*) AS count FROM startup_profiles"
    );
    const [[afterRounds]] = await conn.query(
      "SELECT COUNT(*) AS count FROM emission_rounds"
    );
    const [[afterCompanies]] = await conn.query(
      "SELECT COUNT(*) AS count FROM companies"
    );
    const [admins] = await conn.query(
      "SELECT email FROM users WHERE role = 'admin' ORDER BY id"
    );

    await conn.commit();

    console.log(
      JSON.stringify(
        {
          deleted_non_admin_users: beforeUsers.count - afterUsers.count,
          deleted_startups: beforeStartups.count - afterStartups.count,
          deleted_rounds: beforeRounds.count - afterRounds.count,
          deleted_companies: beforeCompanies.count - afterCompanies.count,
          remaining_admins: admins.map((row) => row.email)
        },
        null,
        2
      )
    );
  } catch (error) {
    await conn.rollback();
    console.error(error);
    process.exitCode = 1;
  } finally {
    conn.release();
    await pool.end();
  }
}

await main();
