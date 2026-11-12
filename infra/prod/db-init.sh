#!/bin/sh
# Initialisation de PostgreSQL en production (exécuté une seule fois, au premier démarrage, volume vide).
# Crée les trois rôles de Kora avec des mots de passe propres à l'environnement, puis la base « kora ».
#   kora_owner    propriétaire des tables, migrations et données de référence uniquement (contourne la RLS)
#   kora_app      rôle de l'API, soumis à la RLS
#   kora_platform rôle de la console éditeur, sans droits sur les données métier
# Les mots de passe sont passés en variables psql (:'...') : jamais interpolés dans le SQL par le shell.
set -eu

: "${KORA_OWNER_PASSWORD:?}" "${KORA_APP_PASSWORD:?}" "${KORA_PLATFORM_PASSWORD:?}"
DB_HOST_ARGS=${DB_HOST_ARGS:-}

psql -v ON_ERROR_STOP=1 $DB_HOST_ARGS -U "${POSTGRES_USER:-postgres}" -d postgres \
  -v owner_pw="$KORA_OWNER_PASSWORD" -v app_pw="$KORA_APP_PASSWORD" -v platform_pw="$KORA_PLATFORM_PASSWORD" <<'SQL'
CREATE ROLE kora_owner LOGIN BYPASSRLS PASSWORD :'owner_pw';
CREATE ROLE kora_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD :'app_pw';
CREATE ROLE kora_platform LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD :'platform_pw';
CREATE DATABASE kora OWNER kora_owner;
SQL

psql -v ON_ERROR_STOP=1 $DB_HOST_ARGS -U "${POSTGRES_USER:-postgres}" -d kora <<'SQL'
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO kora_owner;
SQL

echo "Kora : rôles kora_owner, kora_app, kora_platform et base « kora » créés."
