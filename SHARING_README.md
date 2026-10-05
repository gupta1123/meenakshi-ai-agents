# Meenakshi source snapshot

This archive contains the current working files, including modified and new source files and migrations.

## Local setup

1. Install Node.js 24.x and npm 11.x, matching the backend/frontend package.json requirements.
2. Run `npm ci` separately in `backend/` and `frontend/`. Run it in `tally-bridge/` when using the bridge. There is no root npm workspace/package.json.
3. Copy `backend/.env.example` to `backend/.env.local` and `frontend/.env.example` to `frontend/.env.local`. Supply your own development configuration. Frontend configuration uses the public Supabase URL/key and `NEXT_PUBLIC_API_BASE_URL=http://localhost:3001`. Keep service-role and provider credentials in the backend environment only.
4. Apply the required migration chain in `supabase/migrations/` to your development database. See the backend README and `docs/` for configuration and migration notes.
5. From `backend/`, run `npm run dev`. It starts the API on port 3001, the Tally outbox worker, evaluation worker and notification worker. For local notification verification, the backend README documents `MEENAKSHI_MSG91_TRANSPORT=mock`. `DISABLE_NOTIFICATION_WORKER=1` can disable that worker.
6. In another terminal, from `frontend/`, run `npm run dev`. The frontend opens on port 3000.
7. If needed, follow `tally-bridge/README.md` to configure and pair your own local Tally bridge. Bridge credentials and local pairing state are not in this archive.

Both backend and frontend expose `npm run typecheck` and `npm run build`. The bridge exposes `npm test`.

## Archive contents

Source code, package manifests and lockfiles, environment templates, migrations, documentation and tracked application assets are included. The archive has not been run against a newly configured database.

Every node_modules folder, Git history, real environment files, build and installer binaries, caches, work-cache backups, logs, local downloads/exports and financial document files are excluded. Tests that use excluded document fixtures require those fixtures separately.
