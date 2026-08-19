# Start WardenX Locally

This guide starts the complete local development experience: PostgreSQL, Valkey/Redis,
MinIO, the Fastify API, its worker, and the Vite web application. It is for local
development only; do not use the example credentials or development bypass outside a
throwaway environment.

## Prerequisites

Install the following before starting:

- [Bun](https://bun.sh/) **1.3 or newer** (`bun --version`)
- Docker Desktop or Docker Engine with the Compose plugin (`docker compose version`)

The initial build also needs access to the Bun package registry and Docker image registry.

## 1. Enter the repository and install packages

From the repository root:

```bash
cd wardenx
bun install
```

`bun install` also enables the repository's Git hooks through the `prepare` script.

## 2. Create the local environment file

Copy the template, then add or replace the values below. `.env` is ignored by Git and
must remain local.

```bash
cp .env.example .env
```

Add these settings to `.env` (the database URLs intentionally use different roles):

```dotenv
# Migration/seed connection: PostgreSQL superuser.
DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/wardenx

# Runtime connection: created by `bun run db:migrate` below.
DATABASE_URL=postgres://wardenx_app:wardenx_app@localhost:5432/wardenx
WARDENX_APP_PASSWORD=wardenx_app

# Lets the single-org demo complete pre-organization reads. Never enable in production.
WARDENX_DEV_BYPASSRLS=1

REDIS_URL=redis://localhost:6379
MINIO_ENDPOINT=http://localhost:9000
MINIO_ACCESS_KEY=wardenx
MINIO_SECRET_KEY=wardenx-minio-secret
MINIO_REGION=us-east-1

BETTER_AUTH_URL=http://localhost:3000
BETTER_AUTH_SECRET=wardenx-local-development-secret-change-me
TRUSTED_ORIGINS=http://localhost:3000,http://localhost:5173
NODE_ENV=development
PORT=3000
WORKER_PORT=3001
```

The provided `.env.example` is a broad configuration template. These values align it
with the local Compose services and ensure that the runtime role password stays in sync
with the migration bootstrap.

## 3. Start local dependencies

Start PostgreSQL, Valkey, and MinIO in Docker:

```bash
docker compose up -d postgres redis minio
```

Wait until PostgreSQL and Valkey are healthy:

```bash
docker compose ps
```

The expected local endpoints are PostgreSQL on `localhost:5432`, Valkey on
`localhost:6379`, MinIO S3 on `localhost:9000`, and the MinIO console on
`http://localhost:9001`.

## 4. Create the database schema

Run the migrations once for a new local database:

```bash
bun run db:migrate
```

This applies all migrations and creates/enables the `wardenx_app` login role using
`WARDENX_APP_PASSWORD`. Re-running it is safe: only pending migrations are applied.

## 5. Start the backend, worker, and web app

Use three terminals in `wardenx/`:

```bash
# Terminal 1 — API: http://localhost:3000
bun run dev:backend
```

```bash
# Terminal 2 — background jobs and worker probes: http://localhost:3001
bun --cwd=apps/backend run worker
```

```bash
# Terminal 3 — browser UI: http://localhost:5173
bun run dev:web
```

The web development server proxies `/api` requests to the API at port 3000, so open
`http://localhost:5173` rather than the API URL in your browser.

## 6. Seed a demo organization and users

With the API running, create the local demo organization and accounts:

```bash
bun run db:seed
```

The command writes randomly generated local credentials to
`CREDENTIALS.local.md` (also Git-ignored). Open that file and use the
`admin@wardenx.local` account to sign in at `http://localhost:5173`; choose the
**WardenX Demo Hospice** organization when prompted.

For richer sample data, run these optional seeds after the basic seed. Some require
the web app as well as the API to be running:

```bash
bun run db:seed:patients
bun run db:seed:clinical
bun run db:seed:org-structure
bun run db:seed:staff
```

See `package.json` for additional scenario seed commands.

## 7. Confirm the stack is healthy

In a separate terminal, run:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/ready
curl http://localhost:3001/health
curl http://localhost:3001/ready
```

Each endpoint should return a successful HTTP response. Then open
`http://localhost:5173` and sign in using the generated credentials.

## Verify the checkout (optional but recommended)

Before changing code, verify the repository gates:

```bash
bun run build
bun run arch:fitness
bun run test
```

## Fully containerized API and worker (alternative)

If you only need the backend stack (not the Vite web development server), Compose can
build and run the dependencies, migrate job, API, and worker together:

```bash
docker compose up --build
```

This exposes the API at `http://localhost:3000` and worker probes at
`http://localhost:3001`. It does not start `apps/web`; run `bun run dev:web` separately
to use the browser UI. To seed this stack from the host, configure `.env` as in step 2
and run the seed commands after the API is healthy.

## Stop and restart

Stop the Bun processes with `Ctrl+C`. Keep the dependency containers for the next run,
or stop them with:

```bash
docker compose stop postgres redis minio
```

To start them again, repeat step 3; the Docker volumes preserve the local database and
object-store data. Re-run `bun run db:migrate` after pulling migrations.

## Troubleshooting

| Problem | Resolution |
|---|---|
| Backend reports `password authentication failed for user "wardenx_app"` | Ensure `DATABASE_URL` and `WARDENX_APP_PASSWORD` use the same password, then run `bun run db:migrate` to reset the local runtime-role password. |
| Migration cannot connect | Confirm `docker compose ps` shows `postgres` healthy and that `DATABASE_ADMIN_URL` uses port `5432`. |
| Sign-in has no users or organization choices | Start the API, run `bun run db:seed`, then read `CREDENTIALS.local.md`. Set `WARDENX_DEV_BYPASSRLS=1` and rerun `bun run db:migrate` for the local single-org demo. |
| Web app cannot reach the API | Confirm the API is listening on port `3000`; the Vite proxy is configured for that address. |
| A local reset is required | Stop the local stack, run `docker compose down -v`, then restart from step 3. This permanently removes this Compose project's PostgreSQL and MinIO volumes, so use it only when you intend to discard local data. |

For development architecture and module-extension guidance, continue with
[DEVELOPMENT.md](./DEVELOPMENT.md).
