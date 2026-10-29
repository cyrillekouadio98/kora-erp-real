-- Création des rôles et de la base Kora ERP (exécuté une seule fois par un superutilisateur).
-- En production, remplacez les mots de passe par des secrets issus du coffre.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kora_owner') THEN
    CREATE ROLE kora_owner LOGIN BYPASSRLS PASSWORD 'kora_owner_dev'; -- migrations et données de référence uniquement, jamais utilisé par l'API
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kora_app') THEN
    CREATE ROLE kora_app LOGIN PASSWORD 'kora_app_dev' NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kora_platform') THEN
    CREATE ROLE kora_platform LOGIN PASSWORD 'kora_platform_dev' NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;
