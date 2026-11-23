-- =====================================================================
-- Kora ERP — Migration 0049 : serveur d'envoi des e-mails réglé depuis la console éditeur
-- Une seule ligne ; le mot de passe est chiffré par l'application (AES-256-GCM, ENCRYPTION_KEY).
-- Prioritaire sur la variable SMTP_URL ; sans ligne ni variable, les e-mails ne partent pas.
-- Seul le rôle de la plateforme y accède (aucun droit pour kora_app).
-- =====================================================================
CREATE TABLE platform_mail_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  host text NOT NULL CHECK (length(host) BETWEEN 3 AND 253),
  port integer NOT NULL CHECK (port BETWEEN 1 AND 65535),
  secure boolean NOT NULL,
  username text NOT NULL CHECK (length(username) BETWEEN 1 AND 254),
  password_enc text NOT NULL,
  from_address text NOT NULL CHECK (length(from_address) BETWEEN 3 AND 254),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON platform_mail_settings TO kora_platform;
