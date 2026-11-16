#!/usr/bin/env bash
# Run as root on the server. Creates the Postgres role/database and the app's .env
# with freshly generated secrets. Safe to re-run: an existing .env is left alone.
set -euo pipefail

APP_DIR=/home/spm/gender-map
ENV_FILE="$APP_DIR/.env"
DB_NAME=gender_map
DB_USER=gender_map

if [ -f "$ENV_FILE" ]; then
  echo "$ENV_FILE already exists, leaving it unchanged"
  exit 0
fi

DB_PASS=$(openssl rand -hex 24)
SECRET_KEY=$(openssl rand -hex 32)
ADMIN_PASS=$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)

if sudo -u postgres psql -Atc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1; then
  sudo -u postgres psql -qc "ALTER ROLE $DB_USER WITH LOGIN PASSWORD '$DB_PASS'"
else
  sudo -u postgres psql -qc "CREATE ROLE $DB_USER WITH LOGIN PASSWORD '$DB_PASS'"
fi
if ! sudo -u postgres psql -Atc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1; then
  sudo -u postgres createdb -O "$DB_USER" "$DB_NAME"
fi

umask 077
cat > "$ENV_FILE" <<EOF
SECRET_KEY=$SECRET_KEY
ADMIN_USERNAME=admin
ADMIN_PASSWORD=$ADMIN_PASS
DATABASE_URL=postgresql://$DB_USER:$DB_PASS@127.0.0.1:5432/$DB_NAME
POSTGRES_FALLBACK_TO_SQLITE=0
REDIS_URL=redis://127.0.0.1:6379/1
BEHIND_PROXY=1
EOF
chown spm:spm "$ENV_FILE"
chmod 600 "$ENV_FILE"
echo "Created database $DB_NAME and $ENV_FILE"
