import "../config/env.js";
import mysql from "mysql2/promise";

const {
  DB_HOST = "127.0.0.1",
  DB_PORT = "3306",
  DB_USER = "root",
  DB_PASSWORD = "",
  DB_NAME = "novara_local"
} = process.env;

const rootConnectionConfig = {
  host: DB_HOST,
  port: Number(DB_PORT),
  user: DB_USER,
  password: DB_PASSWORD,
  multipleStatements: true
};

const statements = [
  `
  CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    password VARCHAR(255) NULL,
    role ENUM('investor','startup','admin') NOT NULL,
    email_verified TINYINT(1) NOT NULL DEFAULT 0,
    email_verification_token VARCHAR(64) NULL,
    email_verification_expires DATETIME NULL,
    reset_password_token VARCHAR(64) NULL,
    reset_password_expires DATETIME NULL,
    company_role_check_status VARCHAR(32) NULL,
    company_role_check_checked_at DATETIME NULL,
    company_role_check_orgnr VARCHAR(9) NULL,
    vipps_sub VARCHAR(128) NULL,
    vipps_phone VARCHAR(32) NULL,
    last_login_provider VARCHAR(32) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS companies (
    id INT AUTO_INCREMENT PRIMARY KEY,
    orgnr VARCHAR(9) NOT NULL UNIQUE,
    company_name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS company_memberships (
    id INT AUTO_INCREMENT PRIMARY KEY,
    company_id INT NOT NULL,
    user_id INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_company_user (company_id, user_id),
    UNIQUE KEY uniq_user_single_company (user_id),
    CONSTRAINT fk_company_memberships_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
    CONSTRAINT fk_company_memberships_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS startup_profiles (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    company_name VARCHAR(255) NOT NULL,
    sector TEXT NULL,
    pitch TEXT NULL,
    country VARCHAR(255) NULL,
    vision TEXT NULL,
    raising_amount INT NULL,
    slip_horizon_months INT NULL,
    is_raising TINYINT(1) NOT NULL DEFAULT 0,
    nominal_value_per_share DECIMAL(12,2) NULL,
    current_share_count INT NULL,
    share_basis_temporary TINYINT(1) NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_startup_profiles_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS startup_documents (
    id INT AUTO_INCREMENT PRIMARY KEY,
    startup_id INT NOT NULL,
    filename VARCHAR(255) NOT NULL,
    url TEXT NOT NULL,
    document_type VARCHAR(64) NOT NULL DEFAULT 'pitch_deck',
    mime_type VARCHAR(128) NULL,
    uploaded_by_user_id INT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'uploaded',
    visible_in_document_room TINYINT(1) NOT NULL DEFAULT 1,
    used_for_conversion TINYINT(1) NOT NULL DEFAULT 0,
    parse_status VARCHAR(32) NOT NULL DEFAULT 'not_started',
    parsed_fields_json LONGTEXT NULL,
    extracted_text LONGTEXT NULL,
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_startup_documents_user FOREIGN KEY (startup_id) REFERENCES users(id) ON DELETE CASCADE
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS startup_legal_data (
    id INT AUTO_INCREMENT PRIMARY KEY,
    startup_id INT NOT NULL,
    company_name VARCHAR(255) NOT NULL,
    orgnr VARCHAR(9) NOT NULL,
    amount INT NOT NULL,
    chair_name VARCHAR(255) NOT NULL,
    secretary_name VARCHAR(255) NOT NULL,
    secretary_email VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_startup_legal_data_user FOREIGN KEY (startup_id) REFERENCES users(id) ON DELETE CASCADE
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS capital_decisions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    startup_id INT NOT NULL,
    board_document_id INT NULL,
    gf_document_id INT NULL,
    approved_amount INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_capital_decisions_user FOREIGN KEY (startup_id) REFERENCES users(id) ON DELETE CASCADE
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS documents (
    id INT AUTO_INCREMENT PRIMARY KEY,
    type ENUM('BOARD','GF','RC','SFC','GFC','CONVERSION_BOARD','CONVERSION_GF','CONVERSION_ARTICLES','CONVERSION_SHARE_REGISTER','CONVERSION_CAPITAL_CONFIRMATION','CONVERSION_PACKAGE') NOT NULL,
    startup_id INT NOT NULL,
    title VARCHAR(255) NOT NULL,
    html_content LONGTEXT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'DRAFT',
    document_hash VARCHAR(128) NULL,
    locked_at DATETIME NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_documents_user FOREIGN KEY (startup_id) REFERENCES users(id) ON DELETE CASCADE
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS document_signers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    document_id INT NOT NULL,
    email VARCHAR(255) NOT NULL,
    user_id INT NULL,
    role VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'INVITED',
    signed_at DATETIME NULL,
    ip_address VARCHAR(64) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_document_signers_document FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS emission_rounds (
    id INT AUTO_INCREMENT PRIMARY KEY,
    startup_id INT NOT NULL,
    target_amount INT NOT NULL,
    amount_raised INT NOT NULL DEFAULT 0,
    committed_amount INT NOT NULL DEFAULT 0,
    discount_rate INT NOT NULL DEFAULT 0,
    valuation_cap INT NULL,
    conversion_years INT NULL,
    trigger_period INT NULL,
    bank_account VARCHAR(64) NULL,
    deadline DATETIME NULL,
    open TINYINT(1) NOT NULL DEFAULT 0,
    status VARCHAR(32) NULL,
    closed_at DATETIME NULL,
    closed_reason VARCHAR(32) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_emission_rounds_user FOREIGN KEY (startup_id) REFERENCES users(id) ON DELETE CASCADE
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS emission_shareholders (
    id INT AUTO_INCREMENT PRIMARY KEY,
    emission_id INT NOT NULL,
    shareholder_name VARCHAR(255) NOT NULL,
    ownership_percent DECIMAL(7,4) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_emission_shareholders_round FOREIGN KEY (emission_id) REFERENCES emission_rounds(id) ON DELETE CASCADE
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS rc_invites (
    id INT AUTO_INCREMENT PRIMARY KEY,
    round_id INT NOT NULL,
    token VARCHAR(128) NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_rc_invites_round FOREIGN KEY (round_id) REFERENCES emission_rounds(id) ON DELETE CASCADE
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS rc_agreements (
    id INT AUTO_INCREMENT PRIMARY KEY,
    rc_id VARCHAR(64) NULL,
    round_id INT NOT NULL,
    startup_id INT NOT NULL,
    investor_id INT NOT NULL,
    investment_amount INT NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'Pending Signatures',
    signed_at DATETIME NULL,
    investor_signed_at DATETIME NULL,
    startup_signed_at DATETIME NULL,
    activated_at DATETIME NULL,
    payment_confirmed_by_startup_at DATETIME NULL,
    payment_confirmed_by INT NULL,
    document_hash VARCHAR(128) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_rc_agreements_round FOREIGN KEY (round_id) REFERENCES emission_rounds(id) ON DELETE CASCADE,
    CONSTRAINT fk_rc_agreements_startup FOREIGN KEY (startup_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_rc_agreements_investor FOREIGN KEY (investor_id) REFERENCES users(id) ON DELETE CASCADE
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS rc_payments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    agreement_id INT NOT NULL,
    amount INT NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'Awaiting Payment',
    reference VARCHAR(128) NULL,
    initiated_at DATETIME NULL,
    confirmed_at DATETIME NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_rc_payment_agreement (agreement_id),
    CONSTRAINT fk_rc_payments_agreement FOREIGN KEY (agreement_id) REFERENCES rc_agreements(id) ON DELETE CASCADE
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS startup_plan_subscriptions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    company_id INT NOT NULL,
    user_id INT NOT NULL,
    plan_code VARCHAR(32) NOT NULL,
    billing_period VARCHAR(32) NOT NULL DEFAULT 'annual',
    list_price_nok INT NOT NULL DEFAULT 0,
    final_price_nok INT NOT NULL DEFAULT 0,
    status VARCHAR(32) NOT NULL DEFAULT 'payment_required',
    activation_source VARCHAR(32) NULL,
    payment_reference VARCHAR(128) NULL,
    discount_code_id INT NULL,
    payment_requested_at DATETIME NULL,
    payment_confirmed_by_admin_id INT NULL,
    payment_confirmed_at DATETIME NULL,
    payment_admin_note TEXT NULL,
    starts_at DATETIME NULL,
    expires_at DATETIME NULL,
    activated_at DATETIME NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS startup_discount_codes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    code VARCHAR(64) NOT NULL UNIQUE,
    active TINYINT(1) NOT NULL DEFAULT 1,
    allowed_plan VARCHAR(32) NOT NULL DEFAULT 'normal',
    discount_type VARCHAR(32) NOT NULL DEFAULT 'full',
    discount_percent INT NOT NULL DEFAULT 100,
    max_redemptions INT NOT NULL DEFAULT 1,
    times_redeemed INT NOT NULL DEFAULT 0,
    created_by_user_id INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS startup_discount_redemptions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    discount_code_id INT NOT NULL,
    company_id INT NOT NULL,
    user_id INT NOT NULL,
    subscription_id INT NULL,
    plan_code VARCHAR(32) NOT NULL,
    redeemed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_startup_discount_company (discount_code_id, company_id)
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS admin_issues (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    startup_id INT NOT NULL,
    emission_id INT NULL,
    source VARCHAR(64) NOT NULL DEFAULT 'dashboard',
    issue_type VARCHAR(64) NOT NULL DEFAULT 'general',
    message TEXT NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'OPEN',
    admin_response TEXT NULL,
    resolved_by INT NULL,
    resolved_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_admin_issues_status (status),
    INDEX idx_admin_issues_created_at (created_at),
    INDEX idx_admin_issues_emission_id (emission_id)
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS conversion_events (
    id INT AUTO_INCREMENT PRIMARY KEY,
    startup_id INT NOT NULL,
    round_id INT NOT NULL,
    trigger_type VARCHAR(32) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'draft',
    board_document_id INT NULL,
    gf_document_id INT NULL,
    priced_round_share_price DECIMAL(12,4) NULL,
    conversion_date DATETIME NULL,
    par_value_due_date DATETIME NULL,
    preparation_started_at DATETIME NULL,
    started_automatically TINYINT(1) NOT NULL DEFAULT 0,
    third_party_name VARCHAR(255) NULL,
    third_party_email VARCHAR(255) NULL,
    third_party_confirmed_at DATETIME NULL,
    calculations_json LONGTEXT NULL,
    updated_articles_document_id INT NULL,
    shareholder_register_document_id INT NULL,
    capital_confirmation_document_id INT NULL,
    altinn_package_document_id INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_conversion_events_user FOREIGN KEY (startup_id) REFERENCES users(id) ON DELETE CASCADE
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS conversion_par_value_requests (
    id INT AUTO_INCREMENT PRIMARY KEY,
    conversion_event_id INT NOT NULL,
    agreement_id INT NOT NULL,
    investor_id INT NOT NULL,
    investor_name VARCHAR(255) NULL,
    investor_email VARCHAR(255) NULL,
    par_value_amount DECIMAL(12,2) NOT NULL,
    reference VARCHAR(128) NULL,
    due_date DATETIME NOT NULL,
    notice_sent_at DATETIME NULL,
    paid_confirmed_at DATETIME NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'pending_notice',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )
  `
];

async function bootstrap() {
  let connection;

  try {
    connection = await mysql.createConnection(rootConnectionConfig);
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\``);
    await connection.query(`USE \`${DB_NAME}\``);

    for (const statement of statements) {
      await connection.query(statement);
    }

    console.log(`Local database bootstrap completed for "${DB_NAME}".`);
  } catch (error) {
    console.error("Local database bootstrap failed:", error.message);
    process.exitCode = 1;
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

bootstrap();
