# Backend

Express REST API backed by PostgreSQL through Prisma.

Copy `.env.example` to `.env`, provide `DATABASE_URL` and `JWT_SECRET`, then run migrations before starting the service.

```bash
npm run db:generate
npm run db:migrate
npm run db:seed
npm run dev -w backend
```

Use `npm run db:deploy -w backend` instead of `db:migrate` in production.
