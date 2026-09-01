-- 001_core_auth.sql
-- Phase 2, spec 6.1: login and authentication tables.
--
-- Reconciliations where spec sections are in tension, resolved by the
-- project policy that the more specific section governs:
--
--   Collation: the spec 6 preamble names utf8mb4_0900_ai_ci, a MySQL 8
--   collation that MariaDB does not implement. Spec 2.4 governs:
--   utf8mb4_unicode_ci on every table.
--
--   Timestamps: the spec 6 preamble gives every table id, created_at and
--   updated_at, and says they are not restated per table. Where 6.1 lists a
--   table's columns explicitly (user_sessions, login_attempts, audit_log),
--   that list is treated as complete for the table's timestamps. Append-only
--   log tables carry their event timestamp only, because ON UPDATE on a row
--   that is never updated is wrong.
--
--   user_sessions.csrf_token: named by spec 2.5, absent from the 6.1 column
--   list. Added here as CHAR(64), generated when the session is created.
--
--   rate_limit_hits (spec 2.10) and email_log (spec 2.8) are named by the
--   spec with no column list and no owning migration file. They live here,
--   beside their first phase 2 consumers: login and reset throttling, and
--   the invite and reset mailer.
--
--   users.employee_id carries no foreign key yet. The employees table
--   arrives in phase 6, which adds the FK there (spec 6.1 comment).

CREATE TABLE users (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(190) NOT NULL,
  full_name VARCHAR(120) NOT NULL,
  phone VARCHAR(20) NULL,                      -- E.164, password reset SMS later
  password_hash VARCHAR(255) NULL,             -- NULL until invite accepted
  password_algo ENUM('argon2id','bcrypt') NOT NULL DEFAULT 'argon2id',
  must_change_password TINYINT(1) NOT NULL DEFAULT 1,
  password_changed_at DATETIME NULL,
  totp_secret VARBINARY(255) NULL,             -- AES-256-GCM ciphertext, key from SESSION_SECRET
  totp_confirmed_at DATETIME NULL,
  status ENUM('invited','active','suspended','inactive') NOT NULL DEFAULT 'invited',
  failed_login_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  locked_until DATETIME NULL,
  last_login_at DATETIME NULL,
  last_login_ip VARBINARY(16) NULL,
  employee_id BIGINT UNSIGNED NULL,            -- FK employees.id added in phase 6
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_users_email (email),
  KEY idx_users_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE user_sessions (
  id CHAR(64) PRIMARY KEY,                     -- SHA-256 hex of the 32-byte cookie value
  user_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,                -- absolute 12h expiry, not sliding
  ip VARBINARY(16) NULL,
  user_agent VARCHAR(255) NULL,
  totp_verified TINYINT(1) NOT NULL DEFAULT 0, -- half-authenticated between password and TOTP
  csrf_token CHAR(64) NOT NULL,                -- spec 2.5, one token per session
  revoked_at DATETIME NULL,
  KEY idx_sessions_user (user_id),
  KEY idx_sessions_expiry (expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE password_reset_tokens (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL,                -- SHA-256 hex of the invite or reset token
  purpose ENUM('invite','reset') NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,
  created_ip VARBINARY(16) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_reset_token_hash (token_hash),
  KEY idx_reset_user (user_id),
  CONSTRAINT fk_reset_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE user_recovery_codes (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  code_hash VARCHAR(255) NOT NULL,             -- argon2 hash, single use
  used_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_recovery_user (user_id),
  CONSTRAINT fk_recovery_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE login_attempts (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(190) NULL,                     -- no FK: attempts may reference unregistered emails
  ip VARBINARY(16) NULL,
  succeeded TINYINT(1) NOT NULL,
  attempted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_attempt_email_time (email, attempted_at),
  KEY idx_attempt_ip_time (ip, attempted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE audit_log (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NULL,                -- NULL for cron and system actions
  action VARCHAR(80) NOT NULL,                 -- 'expense.approve', 'user.suspend'
  entity_type VARCHAR(60) NULL,
  entity_id BIGINT UNSIGNED NULL,
  before_json JSON NULL,
  after_json JSON NULL,
  ip VARBINARY(16) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_audit_entity (entity_type, entity_id),
  KEY idx_audit_user_time (user_id, created_at),
  CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Spec 2.10: windowed counter backing the rate limit on POST /login,
-- POST /enquiry and POST /app/files. lib/ratelimit.ts upserts one row per
-- bucket per window with hit_count = hit_count + 1 and reads it back in the
-- same statement. buckets look like 'login:ip:203.0.113.9'.
CREATE TABLE rate_limit_hits (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  bucket VARCHAR(255) NOT NULL,
  window_start DATETIME NOT NULL,              -- floor(now / window), set by lib/ratelimit.ts
  hit_count INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_rate_limit_bucket_window (bucket, window_start),
  KEY idx_rate_limit_window (window_start)     -- cheap purge of expired windows
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Spec 2.8: every outbound email is logged with template key, recipient,
-- related record and the provider response, so a delivery dispute is
-- answerable from the database. Append-only like audit_log.
CREATE TABLE email_log (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  template_key VARCHAR(80) NOT NULL,
  recipient VARCHAR(190) NOT NULL,
  entity_type VARCHAR(60) NULL,
  entity_id BIGINT UNSIGNED NULL,
  status ENUM('sent','failed') NOT NULL,
  response_json JSON NULL,                     -- SMTP accepted/response/messageId
  error_message VARCHAR(500) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_email_log_recipient (recipient),
  KEY idx_email_log_entity (entity_type, entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
