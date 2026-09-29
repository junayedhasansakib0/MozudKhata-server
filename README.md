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
npm run dev            # start the API on http://localhost:4000
```

Key environment variables (see [`.env.example`](./.env.example)): `DATABASE_URL` (Neon Postgres), `CORS_ORIGIN` (allowed client origin), `PORT`/`HOST`, `SESSION_COOKIE_NAME`. Session cookies are unsigned opaque tokens verified by a server-side hash lookup — no `COOKIE_SECRET` (ADR-019). Never commit the real `.env`.

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
| `npm run db:deploy`  | Apply pending migrations (production/CI).                   |
| `npm run db:seed`    | Seed dev data (`prisma/seed.ts`).                           |
| `npm run db:studio`  | Open Prisma Studio.                                         |

## Architecture

Feature-first modules under `src/modules/<feature>/{routes,service,repository,schema}.ts` — routes stay thin, services hold business rules, data access goes through repositories (Prisma). Every request is validated with Zod at the boundary and every query is owner-scoped. Responses use the standard `{ data }` / `{ error }` envelopes ([../docs/api.md](../docs/api.md)). Current modules: `health`, `auth`, `categories`, `products`, `stock`.

Stock is special: **all** quantity changes go through the transactional stock service (`modules/stock`) — an append-only `stock_movements` ledger plus a cached `products.quantity`, both written in one row-locked transaction that enforces non-negative stock (ADR-004). Nothing else ever mutates stock.

## API

Base path `/api/v1`. Documented in full in [../docs/api.md](../docs/api.md):

- **Health:** `GET /health`.
- **Auth & account:** `GET /auth/csrf`, `POST /auth/register|login|logout`, `GET /auth/me`, `PATCH /account`, `POST /account/password`.
- **Categories:** `GET/POST /categories`, `GET/PATCH /categories/:id`, `POST /categories/:id/archive|restore`.
- **Products:** `GET/POST /products` (paginated; `GET` supports `q`/`categoryId`/`stockStatus`/`sort`/`order` search-filter-sort), `GET/PATCH /products/:id`, `POST /products/:id/archive|restore`.
- **Stock movements:** `POST /products/:id/movements` (record IN/OUT/ADJUSTMENT/DAMAGED_LOST), `GET /products/:id/movements` (per-product history, newest first).
- **History:** `GET /movements` (owner-scoped **global** movement history across all products — paginated, newest-first, filterable by `productId`/`type`/`from`/`to`, each row joined with its product name; read-only, no CSRF).
- **Dashboard:** `GET /dashboard` (owner-scoped aggregate metrics — product/stock/low/out/category counts + recent activity; read-only, no CSRF).

Reads require an authenticated session; state-changing requests also require the double-submit CSRF header. See [../docs/security.md](../docs/security.md).

## Status

**Phase 09 — Security & Reliability Hardening complete.** Auth & accounts, category/product CRUD (with server-derived stock status + pagination), stock movement recording/history, product-list search/filter/sort, an owner-scoped aggregate dashboard endpoint, and a global movement-history endpoint (`GET /movements`) are implemented. Phase 09 added targeted defense-in-depth over an already owner-scoped, Zod-validated, auth+CSRF-guarded surface: owner-scoped stock cache write, helmet `Cross-Origin-Resource-Policy: cross-origin`, framework 4xx errors mapped to the safe envelope (no masked 500s), constant-time CSRF compare, explicit `bodyLimit` + `RATE_LIMITED` envelope (ADR-026). **85 tests** pass; typecheck / lint / build green. The Phase 03 `core_domain` migration is authored but **not yet applied** to Neon (applying it is owner-gated). Next: Phase 10 — deployment. See [../PROJECT_STATE.md](../PROJECT_STATE.md) for the live snapshot.
