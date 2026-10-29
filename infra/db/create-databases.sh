#!/bin/sh
# Script d'initialisation du conteneur PostgreSQL (docker-entrypoint-initdb.d)
set -e
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -f /docker-entrypoint-initdb.d/init.sql
for db in kora kora_test; do
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -c "CREATE DATABASE $db OWNER kora_owner"
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$db" -c "REVOKE ALL ON SCHEMA public FROM PUBLIC; ALTER SCHEMA public OWNER TO kora_owner;"
done
