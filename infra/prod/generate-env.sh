#!/usr/bin/env bash
# Génère infra/prod/.env avec des secrets aléatoires. À lancer une seule fois, sur le serveur.
#   ./infra/prod/generate-env.sh app.exemple.ci admin@exemple.ci
# Refuse d'écraser un .env existant : les mots de passe de la base et la clé de chiffrement
# ne doivent jamais changer une fois la base créée.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$DIR/.env"
DOMAIN="${1:-}"
EMAIL="${2:-}"

if [[ -z "$DOMAIN" || -z "$EMAIL" ]]; then
  echo "Usage : $0 <domaine> <email>   (ex. $0 app.exemple.ci admin@exemple.ci)" >&2
  exit 1
fi
if [[ ! "$DOMAIN" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
  echo "Domaine invalide : $DOMAIN" >&2
  exit 1
fi
if [[ -e "$ENV_FILE" ]]; then
  echo "$ENV_FILE existe déjà : rien n'est modifié (les secrets en place doivent être conservés)." >&2
  exit 1
fi

# Mots de passe en hexadécimal : sans caractère spécial, utilisables tels quels dans une URL PostgreSQL.
secret() { openssl rand -hex 24; }
ADMIN_PASSWORD="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)Aa1"

umask 077
cat > "$ENV_FILE" <<EOF
# Généré le $(date -u +%Y-%m-%dT%H:%M:%SZ) par generate-env.sh — NE PAS VERSIONNER, NE PAS PERDRE.
DOMAIN=$DOMAIN
ACME_EMAIL=$EMAIL

POSTGRES_SUPERUSER_PASSWORD=$(secret)
KORA_OWNER_PASSWORD=$(secret)
KORA_APP_PASSWORD=$(secret)
KORA_PLATFORM_PASSWORD=$(secret)

ENCRYPTION_KEY=$(openssl rand -base64 32)

SEED_SUPERADMIN_EMAIL=$EMAIL
SEED_SUPERADMIN_PASSWORD=$ADMIN_PASSWORD
EOF

echo "Fichier $ENV_FILE créé (lisible par son propriétaire uniquement)."
echo
echo "Super administrateur de la console éditeur :"
echo "  e-mail       : $EMAIL"
echo "  mot de passe : $ADMIN_PASSWORD"
echo
echo "Notez ce mot de passe maintenant, activez la double authentification à la première connexion,"
echo "puis retirez les lignes SEED_SUPERADMIN_* de $ENV_FILE."
echo "Sauvegardez aussi une copie de $ENV_FILE hors du serveur (coffre de mots de passe) :"
echo "sans ENCRYPTION_KEY et les mots de passe de la base, une sauvegarde ne peut pas être restaurée à l'identique."
