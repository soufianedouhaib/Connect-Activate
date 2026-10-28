# Connect & Activate console

A browser front end for the Opus workflow Connect and Activate - Order to Activation
Orchestrator (288070de-fbcc-479a-aaab-13725ba7531a), for Orbit Telecom order operations.
Order coordinators submit broadband orders, the Fallout Desk decides the ones the workflow
could not finish, and an admin sees everything.

Live: https://connect-activate-henna.vercel.app

## Run it

```
npm install
OPUS_API_BASE=https://operator.opus.com/api/v1 OPUS_SERVICE_KEY=<key> npm start
```

Then open http://localhost:3000 and pick an account from the sign-in list.

| Setting | What it does |
|---|---|
| `OPUS_API_BASE` | Opus API address, everything before `/case` |
| `OPUS_SERVICE_KEY` | The Opus service key. Server side only; never commit it |
| `SESSION_SECRET` | Signs sign-in sessions; without it everyone is signed out on every restart |
| `OPUS_WEBHOOK_SECRET` | The secret at the end of the Fallout Desk webhook address, `/api/opus/webhook/<secret>` |
| `REVIEW_WINDOW_MINUTES` | The desk's countdown, default 60. Keep it equal to the time limit on the Fallout Desk Review step |
| `DEMO_SIGN_IN` | `off` removes the pick-an-account list; everyone signs in with email and password |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Redis over the Upstash / Vercel KV REST API. Without them orders are kept in memory |

## Layout

- `server.js`: the Express app: sign-in and roles, orders, the Fallout Desk webhook and
  callback, reports, run logs. `api/index.js` is the Vercel entry.
- `lib/opus.js`: the Opus Case API calls (create, execute, status, results, audit).
- `lib/trace.js`: turns the Case Audit Log into package cards, the retry history and the hold.
- `lib/samples.js`: the five example orders and the order record builder.
- `lib/store.js`, `lib/auth.js`: storage and sessions.
- `public/`: the pages, plain HTML and JavaScript, no build step.
- `mock-opus.js`: a stand-in for the workflow for local testing only.

The full API contract is in *Opus API Reference - Connect & Activate.md* in the demo pack.
