CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255),
  email VARCHAR(255) UNIQUE,
  password VARCHAR(255),
  email_verified TINYINT(1) NOT NULL DEFAULT 0,
  email_verification_token VARCHAR(64),
  email_verification_expires DATETIME,
  reset_password_token VARCHAR(64),
  reset_password_expires DATETIME,
  company_role_check_status VARCHAR(32),
  company_role_check_checked_at DATETIME,
  company_role_check_orgnr VARCHAR(9),
  role ENUM('investor','startup') NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS startups (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT,
  name VARCHAR(255),
  industry VARCHAR(255),
  funding_goal INT,
  description TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS investments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  investor_id INT,
  startup_id INT,
  amount INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS slip_agreements (
  id INT AUTO_INCREMENT PRIMARY KEY,
  investor_id INT NOT NULL,
  startup_id INT NOT NULL,
  amount DECIMAL(12,2),
  equity_percentage DECIMAL(5,2),
  signed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (investor_id) REFERENCES users(id),
  FOREIGN KEY (startup_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS activity_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  action VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  message TEXT,
  seen BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS startup_documents (
  id INT AUTO_INCREMENT PRIMARY KEY,
  startup_id INT NOT NULL,
  filename VARCHAR(255),
  url TEXT,
  uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (startup_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS investor_interest (
  id INT AUTO_INCREMENT PRIMARY KEY,
  investor_id INT NOT NULL,
  startup_id INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (investor_id) REFERENCES users(id),
  FOREIGN KEY (startup_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS startup_plan_subscriptions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  user_id INT NOT NULL,
  plan_code VARCHAR(32) NOT NULL,
  billing_period VARCHAR(32) NOT NULL DEFAULT 'annual',
  list_price_nok INT NOT NULL DEFAULT 0,
  final_price_nok INT NOT NULL DEFAULT 0,
  status VARCHAR(32) NOT NULL DEFAULT 'payment_required',
  activation_source VARCHAR(32),
  payment_reference VARCHAR(128),
  discount_code_id INT,
  starts_at DATETIME,
  expires_at DATETIME,
  activated_at DATETIME,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS startup_discount_codes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(64) NOT NULL UNIQUE,
  active TINYINT(1) NOT NULL DEFAULT 1,
  allowed_plan VARCHAR(32) NOT NULL DEFAULT 'basic',
  discount_type VARCHAR(32) NOT NULL DEFAULT 'full',
  discount_percent INT NOT NULL DEFAULT 100,
  max_redemptions INT NOT NULL DEFAULT 1,
  times_redeemed INT NOT NULL DEFAULT 0,
  created_by_user_id INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS startup_discount_redemptions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  discount_code_id INT NOT NULL,
  company_id INT NOT NULL,
  user_id INT NOT NULL,
  subscription_id INT,
  plan_code VARCHAR(32) NOT NULL,
  redeemed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_startup_discount_company (discount_code_id, company_id)
);
