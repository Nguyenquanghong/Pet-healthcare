# NIPOPETO Platform

NIPOPETO is split into two independently deployable applications:

- `frontend/`: React, TypeScript, Vite and Tailwind CSS.
- `backend/`: Express, TypeScript, Prisma, PostgreSQL and JWT authentication.

The root package uses npm workspaces so both applications share one lockfile while keeping runtime configuration separate.

## Local setup

Requirements: Node.js 20+, npm and PostgreSQL 16+. Docker is optional.

1. Install dependencies: `npm install`
2. Copy `frontend/.env.example` to `frontend/.env`.
3. Copy `backend/.env.example` to `backend/.env`.
4. Start PostgreSQL. With Docker: `docker compose up -d postgres`.
5. Run `npm run db:generate`, `npm run db:migrate`, then `npm run db:seed`.
6. Start both applications with `npm run dev`.
7. In another terminal, verify the main API flows with `npm run test:smoke`.

Frontend: `http://localhost:5173`

Backend health check: `http://localhost:5000/api/health`

Demo accounts after seeding:

- Owner: `owner@example.com` / `owner123`
- Admin: `admin` / `admin123`

## Environment variables

Frontend variables live in `frontend/.env`:

- `VITE_API_BASE_URL`: public base URL of the REST API.

Backend variables live in `backend/.env`:

- `DATABASE_URL`: PostgreSQL connection string.
- `JWT_SECRET`: random secret containing at least 32 characters.
- `JWT_EXPIRES_IN`: token lifetime, for example `8h`.
- `CORS_ORIGIN`: comma-separated list of allowed frontend origins.
- `PORT`: API port.

Never commit either `.env` file.

## Production deployment

Deploy `frontend/` as a static Vite application and set `VITE_API_BASE_URL` to the public backend URL. Deploy `backend/` as a Node.js service with a managed PostgreSQL database.

Backend release commands:

```bash
npm install
npm run db:generate
npm run db:deploy -w backend
npm run build -w backend
npm run start -w backend
```

Run `npm run db:seed` only for a new demo or test environment. Do not seed automatically on every production release.

## Data and security

- Passwords are hashed in the backend with PBKDF2 and a per-user random salt.
- JWTs are signed by the backend and every private API route checks the token.
- Owner queries are scoped to the authenticated owner ID; administrative writes require a staff role.
- PostgreSQL migrations are stored in `backend/prisma/migrations`.
- Browser storage contains only the current session token. Business data is loaded from the API.
