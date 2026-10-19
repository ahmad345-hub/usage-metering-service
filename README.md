# Usage Metering and Quota Service

A backend service that other applications call before they let a user do something. The application asks "can this user consume N units?", the service checks the application's shared monthly allowance and the user's own allowance, records the decision, and counts the usage only if the request is accepted.

Built with TypeScript, Express and PostgreSQL. There is one service, one database, and a small example web client.

## Running it


docker compose up --build


- API: http://localhost:3000 (`/health` shows the status)
- Example client: http://localhost:8080

The tables and the predefined plans are created automatically when the service starts, so there is nothing to set up by hand. If one of those ports is already used on your machine, set other ones without editing files:


API_PORT=3001 CLIENT_PORT=8081 docker compose up --build
# PowerShell: $env:API_PORT="3001"; $env:CLIENT_PORT="8081"; docker compose up --build


Tests and load test:


docker compose --profile test run --rm tests                  # 38 automated tests
docker compose up -d db api
docker compose --profile perf run --rm --no-deps loadtest     # load test


To run the service without Docker you need Node 22+ and a PostgreSQL. `docker compose up -d db` starts one on host port 5433, so set `DB_PORT=5433` in `.env` (see `.env.example`), then use `npm ci`, `npm run dev` and `npm test`. The tests start the app inside the test process, so they only need the database.

Settings come from environment variables: `PORT`, `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` and `DB_POOL_MAX`.

## How it works

- **Account**: the application that calls the service. It has an account plan and one API key.
- **User**: a user of that application, identified by the application's own `external_id`. It has a user plan.
- **Plan**: a monthly allowance (units per UTC calendar month) and a maximum per request.
- **Units**: one resource, always a positive whole number.

Both plans apply to every request. A bigger user plan does not make the account's shared allowance bigger, and users on the same plan still have separate usage.

Predefined plans, created at startup and read-only:

| Plan | Type | Monthly allowance | Max per request |
|---|---|---|---|
| Starter | account | 2,400 | 35 |
| Pro | account | 18,000 | 250 |
| Basic | user | 180 | 12 |
| Premium | user | 1,800 | 85 |

An account can also create its own plans, edit them, and assign them to itself or to its users. Custom plans are private to the account that made them.

## API keys

`POST /api/accounts` creates an account and returns its API key. The key is shown once; only its SHA-256 hash is stored. Send it as the `x-api-key` header on every other request. The key identifies the account and only gives access to that account's data. Anything that belongs to another account answers `404` as if it did not exist. A missing key gives `401 missing_api_key` and a wrong one `401 invalid_api_key`.


curl -s localhost:3000/api/plans                                   # predefined plans and their ids
curl -s -X POST localhost:3000/api/accounts -H 'content-type: application/json' \
     -d '{"name":"Docs Inc","plan_id":1}'                          # returns api_key
curl -s -X POST localhost:3000/api/users -H "x-api-key: $KEY" -H 'content-type: application/json' \
     -d '{"external_id":"alice","plan_id":3}'


PowerShell:


$acc = Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/accounts -ContentType "application/json" -Body '{"name":"Docs Inc","plan_id":1}'
$h = @{ "x-api-key" = $acc.api_key }
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/users -Headers $h -ContentType "application/json" -Body '{"external_id":"alice","plan_id":3}'


## Consuming units

`POST /api/usage` with `{ "external_id": "alice", "request_id": "doc-123", "units": 10 }`.

Accepted (`201`):


{ "request_id": "doc-123", "accepted": true, "replayed": false, "units": 10, "month": "2026-10",
  "rejection": null,
  "user":    { "external_id": "alice", "plan": { "id": 3, "name": "Basic", "type": "user", "predefined": true,
               "monthly_limit": 180, "max_per_request": 12 }, "used_units": 10, "remaining_units": 170 },
  "account": { "plan": { "id": 1, "name": "Starter", "type": "account", "predefined": true,
               "monthly_limit": 2400, "max_per_request": 35 }, "used_units": 10, "remaining_units": 2390 } }


Rejected (`429`): nothing is consumed, and `rejection` says which rule of which level stopped it:


{ "accepted": false, "rejection": { "level": "user", "rule": "max_per_request",
  "message": "Rejected by the user's per-request limit" }, "...": "same user and account blocks" }


`level` is `account` or `user`, and `rule` is `monthly_limit` or `max_per_request`. Other status codes: `400` invalid input, `404` unknown user, `409` the `request_id` was already used with different data. The response always includes both plans and the remaining units, so the caller can explain a decision without another request.

## All endpoints

| Endpoint | What it does |
|---|---|
| `POST /api/accounts` | Create an account (predefined account plan), returns the key once |
| `GET /api/accounts/me` | The calling account and its plan |
| `PUT /api/accounts/me/plan` | Switch the account plan: `{plan_id}` |
| `POST /api/users` | Register a user: `{external_id, plan_id}` |
| `GET /api/users`, `GET /api/users/:externalId` | List users, or get one |
| `PATCH /api/users/:externalId` | Switch a user's plan: `{plan_id}` |
| `GET /api/plans?type=account\|user` | Predefined plans (public) |
| `GET /api/plans/custom`, `GET /api/plans/:id` | The account's own plans, or one plan |
| `POST /api/plans` | Create a custom plan: `{name, plan_type, monthly_limit, max_per_request}` |
| `PATCH /api/plans/:id` | Edit a custom plan |
| `GET /api/usage/summary?month=` | Account usage and remaining units |
| `GET /api/usage/users?month=` | Usage and remaining units of all users |
| `GET /api/usage/users/:externalId/summary?month=` | One user's usage |
| `GET /api/usage/months` | Months in which the account used units |
| `GET /api/usage/history?month=&external_id=&accepted=` | Accepted and rejected requests, newest first |

Lists use `page` and `limit` (default 20, maximum 100) and return `total`. `month` looks like `2026-09`. Every error is JSON: `{ "code": "...", "message": "..." }`.

## Rules

There are two rule types, in both account plans and user plans: the monthly allowance and the maximum per request. A request has to pass all four checks, in this order, and the first one that fails is reported: account per-request, user per-request, account monthly, user monthly. I check the per-request rules first because a retry can never fix them, while a monthly rule can clear later.

A monthly check rejects when `used + units` is more than the allowance, so using exactly the allowance is fine. A request is accepted in full or rejected in full. When it is accepted, the same units are added to the user's total and the account's total for the current UTC month, so the account total is always the sum of its users. A new month starts at zero, and previous months can still be queried.

The rules are one small function with no database access (`src/services/quotaService.ts`), so another rule type would be added there without touching the rest. I did not add extra rule types. The brief says a reliable core matters more than extras.

## Changing plans

- Editing a custom plan applies to the next request. The plan is read inside the same transaction that makes the decision, and nothing is cached.
- Switching a plan keeps the units already used. Usage is stored per user and per account, not per plan, so a switch never gives a fresh allowance.
- If an allowance is lowered below what was already used, remaining shows 0 and requests are rejected at that level until the allowance is raised or the month changes.
- Past decisions are never changed, so the history stays correct after plan changes.

## Retries and concurrency

`request_id` is unique per account. Sending the same one again returns the original decision with `replayed: true` and consumes nothing, for accepted and rejected requests. Using it again with a different user or amount returns `409`. The used and remaining numbers in a replay are the current ones, not the ones from the first call. A rejected `request_id` stays rejected, so after raising a limit the caller sends a new `request_id` (the example client does this on every click).

Every decision, plan edit and plan switch runs in a transaction that first takes a PostgreSQL advisory lock for the account. That makes "check the allowance, then write the usage" one atomic step per account, so concurrent requests can never go over a limit or be counted twice. Different accounts do not wait for each other. A unique constraint on `(account_id, request_id)` is a second safety net for retries.

## Database

The schema is in `db/init.sql` and is applied every time the service starts (it is written to be safe to run again). The main tables are `plans`, `accounts`, `users`, `usage_records` and `usage_requests`.

- `plans.account_id` is empty for predefined plans, and holds the owner for custom ones.
- `usage_records` has one row per user per month and one per account per month. It has no link to plans, which is why switching plans keeps usage.
- `usage_requests` has every decision, accepted or rejected, and it is what the history shows.

Everything is stored in PostgreSQL (volume `pgdata`), so it survives a restart.

## Example client

Open http://localhost:8080. It is a small document-processing page for a made-up company, *Docs Inc*. The processing itself is simulated; the page shows what the metering service decides. The browser never sees the API key: the page talks to the client's own small server (`client/server.mjs`), which keeps the key and calls the metering service. The client knows nothing about the limits, so changing a plan changes what users can do without changing the client.

At startup it creates a demo account with a custom plan (60 units a month, 30 per request), alice on Basic and bob on Premium. To see the main cases, press **Reset demo** and then:

1. alice, 10 units: accepted.
2. alice, 20 units: rejected by her per-request limit (Basic allows 12).
3. bob, 30 units: accepted.
4. bob, 30 units again: rejected by the account's monthly allowance, even though bob still has 1770 units of his own.
5. In **Plans**, set the monthly allowance of the demo plan to 600 and save, then bob, 30 units: accepted.
6. In **Users**, switch alice to Premium, then alice, 20 units: accepted.

The page shows the decision and the rule behind a rejection, the remaining units of the account and each user, the plans in use, and the recent decisions. Only the custom plan can be edited there; the predefined ones are read-only.

## Performance

`perf/loadtest.mjs` uses autocannon (50 connections, 10 seconds per scenario). After each scenario it checks that the account total, the sum of the user totals and the number of accepted decisions in the history are equal. How I tested it and what I learned is in [`perf/RESULTS.md`](perf/RESULTS.md). Results from my laptop:

| Scenario | Requests/s | Correct |
|---|---|---|
| One account, 50 users | 102 | yes |
| 20 accounts at the same time | 376 | yes |
| Account limit reached under load | 105 | yes, exactly the limit |
| Same request ids sent again and again | 189 | yes, each counted once |

The totals were correct every time. The lock makes one very busy account slower (about 3.7 times) than the same load spread over 20 accounts, which is the price of correct counting.

## Decisions I made where the brief was open

1. The UTC month is taken from the server clock when the request is processed.
2. A rejection returns HTTP 429 with a body that explains it.
3. Creating an account is open, because the brief has an API key per account but no admin role (roles are out of scope). In production I would protect or limit this endpoint.
4. API keys cannot be rotated or revoked, so valid keys are cached in memory.
5. Predefined plans are read-only and shared. Custom plans can be edited, but not deleted and their type cannot change, because users and history may refer to them.
6. A new account starts on a predefined account plan and can switch to its own plan afterwards.
7. `remaining_units` is only given for the current month. In past months the account or user may have been on a different plan, so today's limits would give a wrong number. Used units and history stay exact.
8. An allowance of 0 is valid. Requests of 0, negative or fractional units are rejected.
9. Limits are at most 1,000,000,000,000 units and one request at most 2,147,483,647.
10. `external_id` and `request_id` are text of up to 100 characters.

## Limitations

- Requests of the same account run one after another because of the lock, so one very busy account has limited throughput (see `perf/RESULTS.md`).
- One PostgreSQL, no replicas. Several service instances would still be correct because the lock is in the database.
- No key rotation, no deleting accounts, users or plans, and no saved snapshot of plans per month.
- The example page only works with its demo account. Users and custom plans are created through the API, not from the page. The page loads its CSS and fonts from CDNs, so it needs internet to look right.
- No billing, refunds, several resources, end-user login or roles (all outside the scope).

## Project layout


compose.yaml      database, service and example client (plus "test" and "perf" profiles)
Dockerfile        the metering service
db/init.sql       schema and predefined plans
src/services/     quotaService (rules), usageService (accounting), planService
src/routes/       accounts, users, plans, usage
src/middleware/   API key check, error handling
src/db/           schema runner, per-account lock
tests/            38 tests
perf/             load test and results
client/           example application


I ran `docker compose up --build`, the tests, the load test and the example client with Docker Desktop on Windows.
