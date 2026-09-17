import db from "../config/db.js";

async function columnExists(connection, tableName, columnName) {
  const [rows] = await connection.query(
    `
    SELECT 1
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ?
      AND COLUMN_NAME = ?
    LIMIT 1
    `,
    [tableName, columnName]
  );

  return rows.length > 0;
}

async function tableExists(connection, tableName) {
  const [rows] = await connection.query(
    `
    SELECT 1
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ?
    LIMIT 1
    `,
    [tableName]
  );

  return rows.length > 0;
}

export async function ensureEmissionRoundSchema() {
  const connection = await db.getConnection();

  try {
    const exists = await tableExists(connection, "emission_rounds");
    if (!exists) {
      return;
    }

    const invitesExists = await tableExists(connection, "emission_invites");
    if (!invitesExists) {
      await connection.query(
        `
        CREATE TABLE emission_invites (
          id INT AUTO_INCREMENT PRIMARY KEY,
          emission_id INT NOT NULL,
          email VARCHAR(255) NOT NULL,
          invite_token VARCHAR(128) NOT NULL,
          status VARCHAR(32) NOT NULL DEFAULT 'SENT',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_emission_invites_emission (emission_id),
          CONSTRAINT fk_emission_invites_emission FOREIGN KEY (emission_id) REFERENCES emission_rounds(id) ON DELETE CASCADE
        )
        `
      );
    }

    const draftsExist = await tableExists(connection, "emission_round_drafts");
    if (!draftsExist) {
      await connection.query(
        `
        CREATE TABLE emission_round_drafts (
          round_id INT NOT NULL PRIMARY KEY,
          startup_id INT NOT NULL,
          draft_json LONGTEXT NOT NULL,
          last_step TINYINT NOT NULL DEFAULT 1,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_emission_round_drafts_startup (startup_id, updated_at),
          CONSTRAINT fk_emission_round_drafts_round FOREIGN KEY (round_id) REFERENCES emission_rounds(id) ON DELETE CASCADE
        )
        `
      );
    }

    const investorProgressExists = await tableExists(connection, "investor_flow_progress");
    if (!investorProgressExists && await tableExists(connection, "rc_invites")) {
      await connection.query(
        `
        CREATE TABLE investor_flow_progress (
          investor_id INT NOT NULL,
          invite_id INT NOT NULL,
          stage VARCHAR(16) NOT NULL DEFAULT 'terms',
          amount INT NULL,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (investor_id, invite_id),
          INDEX idx_investor_flow_progress_updated (investor_id, updated_at),
          CONSTRAINT fk_investor_flow_progress_invite FOREIGN KEY (invite_id) REFERENCES rc_invites(id) ON DELETE CASCADE
        )
        `
      );
    }

    const columns = [
      {
        name: "trigger_period",
        sql: "ALTER TABLE emission_rounds ADD COLUMN trigger_period INT NULL"
      },
      {
        name: "committed_amount",
        sql: "ALTER TABLE emission_rounds ADD COLUMN committed_amount INT NOT NULL DEFAULT 0"
      },
      {
        name: "closed_at",
        sql: "ALTER TABLE emission_rounds ADD COLUMN closed_at DATETIME NULL"
      },
      {
        name: "closed_reason",
        sql: "ALTER TABLE emission_rounds ADD COLUMN closed_reason VARCHAR(32) NULL"
      }
    ];

    for (const column of columns) {
      const exists = await columnExists(connection, "emission_rounds", column.name);
      if (!exists) {
        await connection.query(column.sql);
      }
    }

    await connection.query(
      `
      UPDATE emission_rounds er
      LEFT JOIN (
        SELECT
          round_id,
          COALESCE(SUM(investment_amount), 0) AS committed_amount
        FROM rc_agreements
        WHERE status = 'Active RC'
        GROUP BY round_id
      ) committed ON committed.round_id = er.id
      SET er.committed_amount = COALESCE(committed.committed_amount, 0)
      `
    );

    /*
      Existing shareholders are recorded by share count — the unit the
      aksjeeierbok uses. The percentage stays, derived from the count, and the
      source records whether the founder typed shares or a percentage.
    */
    if (await tableExists(connection, "emission_shareholders")) {
      for (const [name, sql] of [
        ["share_count", "ALTER TABLE emission_shareholders ADD COLUMN share_count INT NULL"],
        ["input_source", "ALTER TABLE emission_shareholders ADD COLUMN input_source VARCHAR(16) NULL"]
      ]) {
        if (!(await columnExists(connection, "emission_shareholders", name))) {
          await connection.query(sql);
        }
      }
    }

    if (await columnExists(connection, "emission_rounds", "trigger_period")) {
      await connection.query(
        `
        UPDATE emission_rounds
        SET trigger_period = COALESCE(trigger_period, conversion_years)
        `
      );
    }
  } finally {
    connection.release();
  }
}
