CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255),
  email VARCHAR(255) UNIQUE,
  password VARCHAR(255),
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
