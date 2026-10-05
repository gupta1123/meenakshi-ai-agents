# Production pipeline

Push development changes to `nyx-solutions-team/meenakshi-ai-agents`, branch `main`.
The `Validate, sync and deploy` Actions workflow checks both applications and the
backend tests, then synchronizes the exact commit to `gupta1123/meenakshi-ai-agents`,
deploys an archive of `backend/` through Heroku's Builds API, and deploys `frontend/` to Netlify.
Production API, CORS, Netlify deployment identity and frontend HTTP checks finish
the release. Pull requests run validation only. The mirrored workflow does not
release from Gupta. Main releases are serialized and never force-push.

## Actions secrets in Nyx

- `GUPTA_REPO_TOKEN`: fine-grained GitHub token for the Gupta repository with
  Contents and Workflows write permission. Its account must have repository write
  access. Keep Gupta main free of independent edits; reconcile any divergence in
  Nyx before rerunning a failed synchronization.
- `HEROKU_API_KEY`: dedicated Heroku read/write deployment authorization. Rotate before expiry.
- `NETLIFY_AUTH_TOKEN`: token belonging to an account with deployment access to the
  production Netlify site.
- `NETLIFY_SITE_ID`: ID of `meenakshi-ai-agents.netlify.app`; the workflow rejects
  IDs for other sites.
- `SUPABASE_PUBLISHABLE_KEY`: the public frontend key for the existing Supabase
  project. Never use a service-role or secret key here.

URLs and Node versions are defined in `.github/workflows/production.yml`.
Netlify build settings remain in the root `netlify.toml`. The workflow supplies
the deployed backend URL and public Supabase configuration to the frontend build.
Backend secrets remain in Heroku; this pipeline does not change them or apply
database migrations. Worker scaling is managed separately in Heroku.

## Operations

Open Nyx's Actions tab and select the workflow to see validation/release logs.
Use **Run workflow** on `main` to retry after correcting credentials or a service
failure. A failed mirror stops deployments. A backend failure stops the frontend
deployment. Frontend failure can leave the backend at the newer release; inspect
the run before retrying or rolling back through the hosting provider.

Use this workflow as the production deploy trigger. Disable any separate
automatic deploy on Gupta/Netlify/Heroku if it would publish the same push before
this workflow completes. Tokens must remain in Actions secrets, never Git.
