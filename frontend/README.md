# Meenakshi Rulebook frontend

This is the separate Phase 3 administrator UI. It signs in with Supabase Auth and calls the Meenakshi backend; it never receives a service-role key or a Tally bridge credential.

## Local run

1. Copy `.env.example` to `.env.local`.
2. Set the public Supabase URL and publishable key, plus `NEXT_PUBLIC_API_BASE_URL=http://localhost:3001`.
3. In a separate terminal, start the backend from `../backend` with `npm run dev`.
4. From this folder run:

```powershell
npm run dev
```

Open `http://localhost:3000`, sign in as an organization administrator, and select the synchronized Tally company.

The Rulebook pages require the Phase 3 activation migration to be applied before validation/activation endpoints can work. See `../docs/api-reference.md` for the safe configuration and test sequence.
