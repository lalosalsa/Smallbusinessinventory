# Putting it online

The app is a Node server plus a folder of static files. It runs anywhere Node runs. Two
routes are set up ready to go; pick one.

Whichever you choose, you need two environment variables:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Your Supabase **Transaction pooler** connection string (`docs/supabase-setup.md`) |
| `AUTH_SECRET` | Any long random string. `npm run secret` prints a good one. It signs sign-in tokens, so set it once and leave it — changing it signs everyone out. |

## Vercel

Vercel runs the API as a serverless function and serves `public/` as static files. The
repo already carries the config for that (`vercel.json`, `api/index.js`).

1. **Add New → Project**, import this repository. Leave the framework preset as **Other**
   and the build settings blank — there is nothing to build.
2. Under **Environment Variables**, add `DATABASE_URL` and `AUTH_SECRET`.
3. **Deploy.** Open the project's production domain, `https://<project>.vercel.app`.

Every push to the branch deploys again. Use the production domain to reach the app, not
the per-deployment `...-abc123.vercel.app` links from the dashboard: those point at one
build and can go away.

### The two error pages you might have seen

- **"The page could not be found — NOT_FOUND"** on the sign-in screen means Vercel served
  the static files but nothing was answering `/api`. That is what happens without
  `vercel.json` and `api/index.js` — pull the latest code and redeploy.
- **"The deployment could not be found — DEPLOYMENT_NOT_FOUND"** means the URL points at
  a deployment that no longer exists. Use the production domain from the project's
  Overview page.

If sign-in fails straight after deploying, the API will tell you what is missing
(`DATABASE_URL`, `AUTH_SECRET`, or a database it cannot reach) in the message on screen.

### Things to know on Vercel

- The database schema is applied on the first request each new instance handles. It is
  idempotent and takes a moment; you may notice the very first load after a deploy is
  slower.
- Use the Supabase **Transaction pooler** (port 6543), not the direct connection. Serverless
  instances come and go, and the pooler is built for exactly that.
- Sign-in tokens last 30 days and are signed with `AUTH_SECRET`, so the app needs no
  server-side session store.

## Render (or Railway, Fly, a VPS)

A plain always-on Node process. Simpler to reason about, and the free tier is enough for a
few locations, though it sleeps after inactivity and takes a moment to wake.

1. **New → Blueprint**, pick this repository. `render.yaml` describes the service.
2. Fill in `DATABASE_URL` and `AUTH_SECRET` when prompted.
3. Deploy. The app is at `https://<service>.onrender.com`.

On any other host: `npm install && npm start` with those two variables set and `PORT` if
the host assigns one. No build step.

## Custom domain

Point it at the host as their docs describe. Nothing in the app depends on the domain.

## Checking a deployment

Open `https://<your-app>/api/auth/config`. A healthy deployment answers
`{"mode":"local"}`. A host error page there means the API is not running; a JSON error
names what is missing.
