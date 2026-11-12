#!/usr/bin/env bash
# Sauvegarde de la base « kora » (format personnalisé pg_dump, compressé). Lancé chaque nuit par cron
# (voir setup-server.sh) et avant chaque déploiement. Conserve les KEEP_DAYS derniers jours.
#   sudo ./infra/prod/backup.sh
# Restauration (base vide) :
#   docker compose -f infra/prod/docker-compose.yml --env-file infra/prod/.env exec -T db \
#     pg_restore -U postgres -d kora --clean --if-exists < infra/prod/backups/kora-AAAAMMJJ-HHMMSS.dump
#
# Ces sauvegardes restent sur le serveur : copiez-les régulièrement ailleurs (stockage d'objets,
# autre machine). Une sauvegarde sur le même disque ne protège pas contre la perte du serveur.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$DIR/backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
COMPOSE=(docker compose -f "$DIR/docker-compose.yml" --env-file "$DIR/.env")

umask 077
mkdir -p "$BACKUP_DIR"
FILE="$BACKUP_DIR/kora-$(date -u +%Y%m%d-%H%M%S).dump"

"${COMPOSE[@]}" exec -T db pg_dump -U postgres -d kora -Fc > "$FILE.partial"
mv "$FILE.partial" "$FILE"   # un fichier .dump n'existe que s'il est complet

find "$BACKUP_DIR" -name 'kora-*.dump' -mtime +"$KEEP_DAYS" -delete
echo "$(date -u +%FT%TZ) sauvegarde $(basename "$FILE") ($(du -h "$FILE" | cut -f1))"
