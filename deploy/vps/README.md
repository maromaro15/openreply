# OpenReply on a VPS

One server, Docker Compose: Postgres, Redis, the app, the Instagram worker, the
Facebook worker (ffmpeg for voice messages), a cron scheduler and Caddy (HTTPS).
Only ports 80 and 443 are published. An Arabic guide will follow.

Run every command below from `deploy/vps`.

## First install

1. Point a DNS A record (for example `bot.example.com`) to the VPS. Open ports 80 and 443.
2. Install Docker with the Compose plugin.
3. `cp .env.example .env && chmod 600 .env`, then fill it in. Required: `DOMAIN`,
   `ACME_EMAIL`, `POSTGRES_PASSWORD`, `NEXTAUTH_SECRET`, `CRON_SECRET`,
   `ENCRYPTION_KEY` (64 hex), the email settings, and the Meta and `GOOGLE_API_KEY`
   values for the channels you use. Back up `ENCRYPTION_KEY`: without it the
   stored tokens cannot be read.
4. `docker compose config -q` checks the file and that required values are set.
5. `docker compose up -d --build`. The app applies the database migrations
   before it starts; the workers and Caddy wait for it to be healthy.
6. Open `https://$DOMAIN`. The Facebook webhook URL is
   `https://$DOMAIN/api/facebook/webhook`.

## Update

```
git pull
docker compose up -d --build
```

Migrations run on every app start. Take a backup first (below) when the update
adds migrations.

## Logs and status

```
docker compose ps
docker compose logs -f app
docker compose logs -f worker facebook-worker
docker compose logs --since 1h caddy
```

## Backup and restore

`backup.sh` writes a custom-format `pg_dump` to `./backups` (change with
`BACKUP_DIR`), keeps the newest 14 (`BACKUP_KEEP`), and can run
`BACKUP_UPLOAD_CMD` with the file path to copy it off the server. Schedule it:

```
15 3 * * * /opt/openreply/deploy/vps/backup.sh >> /var/log/openreply-backup.log 2>&1
```

Restore (this replaces the current data):

```
docker compose stop app worker facebook-worker cron
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner' < backups/openreply-YYYYMMDDTHHMMSSZ.dump
docker compose start app worker facebook-worker cron
```

Redis holds only queued jobs; it is kept on disk (`appendonly`) but is not part
of the backup.

## Notes

- The app and Instagram worker use the repo's root `Dockerfile` (Node 20, root
  user). The Facebook worker image is `facebook-worker.Dockerfile` (Node 22,
  non-root, build fails if ffmpeg lacks the `cache` protocol).
- `DATABASE_URL`, `REDIS_URL` and `NEXTAUTH_URL` are set by the compose file;
  do not put them in `.env`.
