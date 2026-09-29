# MozudKhata — Server (Backend API)

REST API for MozudKhata (inventory & stock management). Fastify + TypeScript + Prisma + PostgreSQL.

> This is one of two repositories. The frontend lives in `../client`. Shared, governing docs live in the root workspace: [`../PROJECT.md`](../PROJECT.md), [`../AGENTS.md`](../AGENTS.md), [`../docs/`](../docs) (see especially `architecture.md`, `api.md`, `database.md`, `security.md`).

## Requirements

- Node.js ≥ 20 (v22 recommended)
- npm
- A PostgreSQL database (Neon free tier) for running migrations / real data

## Setup

```bash
npm install
cp .env.example .env   # then fill in DATABASE_URL and others
npm run db:generate    # generate the Prisma client
```

## Scripts

| Script               | Purpose                                                     |
| -------------------- | ----------------------------------------------------------- |
| `npm run dev`        | Start the API with hot reload (tsx).                        |
| `npm run build`      | Type-check + compile to `dist/`.                            |
| `npm start`          | Run the compiled server.                                    |
| `npm run typecheck`  | TypeScript type-check only.                                 |
| `npm run lint`       | ESLint.                                                     |
| `npm test`           | Run Vitest (unit + API tests).                              |
| `npm run db:migrate` | Create/apply a dev migration (needs a real `DATABASE_URL`). |
| `npm run db:studio`  | Open Prisma Studio.                                         |

## Status

Phase 01 — foundation. Serves `GET /api/v1/health`. No data models yet (added in Phase 03). Auth arrives in Phase 02.
