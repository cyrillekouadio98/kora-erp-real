#!/usr/bin/env bash
# Déploie (ou met à jour) Kora ERP depuis la branche prod. À lancer sur le serveur, en root :
#   sudo ./infra/prod/deploy.sh
# Étapes : récupération du code → sauvegarde de la base → construction des images →
# redémarrage (les migrations s'appliquent au démarrage de l'API) → vérification de santé.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$DIR/../.." && pwd)"
BRANCH="${BRANCH:-prod}"
COMPOSE=(docker compose -f "$DIR/docker-compose.yml" --env-file "$DIR/.env")

[[ -f "$DIR/.env" ]] || { echo "infra/prod/.env manquant : lancez d'abord generate-env.sh." >&2; exit 1; }
DOMAIN="$(grep -E '^DOMAIN=' "$DIR/.env" | cut -d= -f2-)"

echo "→ Code : branche $BRANCH"
cd "$REPO_DIR"
git fetch --quiet origin "$BRANCH"
git checkout --quiet "$BRANCH"
git merge --ff-only --quiet "origin/$BRANCH"   # échoue plutôt que d'écraser une modification locale
echo "  $(git log --oneline -1)"

if "${COMPOSE[@]}" ps --status running --services 2>/dev/null | grep -qx db; then
  echo "→ Sauvegarde avant mise à jour"
  "$DIR/backup.sh"
fi

echo "→ Construction des images (l'une après l'autre : le serveur peut n'avoir que 2 Go de mémoire)"
"${COMPOSE[@]}" build --pull api
"${COMPOSE[@]}" build --pull web

echo "→ Démarrage (migrations appliquées au démarrage de l'API)"
"${COMPOSE[@]}" up -d --remove-orphans

echo "→ Vérification de santé de l'API"
for i in $(seq 1 30); do
  status="$(docker inspect -f '{{.State.Health.Status}}' "$("${COMPOSE[@]}" ps -q api)" 2>/dev/null || echo starting)"
  [[ "$status" == healthy ]] && break
  if [[ $i -eq 30 ]]; then
    echo "L'API n'est pas saine après 5 minutes. Derniers journaux :" >&2
    "${COMPOSE[@]}" logs --tail 80 api >&2
    exit 1
  fi
  sleep 10
done
echo "  API saine."

docker image prune -f >/dev/null
docker builder prune -f --filter until=168h >/dev/null   # cache de build de plus de 7 jours : le disque reste disponible
echo
echo "Kora ERP est en ligne : https://$DOMAIN"
echo "Journaux : docker compose -f $DIR/docker-compose.yml --env-file $DIR/.env logs -f"
