# Performance results

## How it was tested

* Tool: [autocannon](https://github.com/mcollina/autocannon) driven by `perf/loadtest.mjs` (committed). 50 concurrent connections, 10 s per scenario. Every request consumes 1 unit with a unique `request_id`, except scenario 4.
* Every scenario ends with a **correctness check**, not just a speed number. After autocannon stops, the script waits until the service's totals stop moving (requests in flight at the deadline still finish server-side) and then requires:
  `account used == sum of user used == number of accepted decisions in the request history`, and that this count is within the in-flight window (<= connections) of what the client saw as `201`. Scenario 3 must accept **exactly** its limit and scenario 4 must count each request id **exactly** once. A mismatch fails the run (exit code 1).
* Environment: Windows laptop, Intel Core i7-8565U (4 cores / 8 threads, 1.8 GHz base), 8 GB RAM, Docker Desktop. PostgreSQL 17 (default settings) and the Node service ran in containers with a connection pool of 20. The load generator ran in a third container on the same machine, so the three compete for the same CPU and memory. Treat absolute numbers as a floor; the relative comparisons are the useful part.

Reproduce:

```bash
docker compose up -d db api
docker compose --profile perf run --rm --no-deps loadtest      # or: npm run perf  (service on :3000)
# options: DURATION=10 CONNECTIONS=50 BASE_URL=http://localhost:3000
```

## Results (run committed as `perf/last-run.md`)

| Scenario | req/s | p50 ms | p99 ms | 201 | 429 | 200 (replay) | errors | correctness |
|---|---|---|---|---|---|---|---|---|
| 1. one account, 50 users, all accepted | 102 | 494 | 726 | 1016 | 0 | 0 | 0 | OK |
| 2. 20 accounts x 10 users, all accepted | 376 | 120 | 278 | 3758 | 0 | 0 | 0 | OK |
| 3. account limit 406, requests >> limit | 105 | 468 | 647 | 406 | 647 | 0 | 0 | OK (exactly 406) |
| 4. retry storm, 254 unique request ids | 189 | 254 | 465 | 254 | 0 | 1631 | 0 | OK (exactly 254) |

(The limit of scenario 3 and the number of ids of scenario 4 are sized from what scenario 1 served, so the limit is always exceeded regardless of machine speed.)

The automated test-suite additionally checks contention with real assertions (`tests/consumption.test.ts`): 200 concurrent requests on a user with a 50-unit allowance accept exactly 50; 300 concurrent requests across 10 users against a 100-unit account allowance accept exactly 100 with user totals summing to the account total; 40 concurrent copies of one `request_id` count once; a plan edit racing with consumption never loses or double counts units.

## What I learned

1. **Correctness held under contention.** No over-commit, no double counting and no errors in any scenario. This comes from one rule: every decision for an account runs in a transaction holding that account's advisory lock (`src/db/tx.ts`), so "check the allowance" and "write the usage" are atomic per account. The `UNIQUE (account_id, request_id)` constraint is a second safety net for idempotency.
2. **The per-account lock is the bottleneck for a single account, and it is the price of correctness.** One account (scenarios 1, 3, 4) handled about 100-190 req/s, while 20 accounts in parallel handled 376 req/s (about 3.7x more). Requests of one account run strictly one after another, and 1 / 102 req/s is about 10 ms of critical section per request. Different accounts never wait for each other, so total throughput grows with the number of active accounts, which is the realistic shape for a metering service shared by many applications.
3. **Latency here is queueing, not slow requests.** With 50 connections, Little's law predicts about 50 / 102 = 490 ms for scenario 1, and the measured p50 is 494 ms. For scenario 2, 50 / 376 = 133 ms against a measured 120 ms.
4. **What is inside the lock matters.** The time a request holds the lock is the number of sequential statements times the round-trip time to PostgreSQL (BEGIN, lock, idempotency lookup, load plans and usage, write, COMMIT). Retries (scenario 4) skip the write, and ran faster (189 req/s) than new requests on the same kind of account (102 req/s). Rejections write one history row, like acceptances, and cost the same (105 req/s).
5. **Reducing statements per request.** The consume path was reduced from 10 sequential statements plus 1 authentication query to 6 statements (one query loads both plans and both usage counters, one statement writes both counters and the history row, and valid API keys are cached in memory). Because the lock is held across these round trips, this should matter most for a single busy account, especially when PostgreSQL is not on the same host. I did not benchmark the old and new code against each other on this machine, so this is an expectation, not a measured result. To measure it, run `perf/compare.mjs` against the commit before the change and against this one.

## What I would do next

* Shorten the critical section further: for a very hot account, replace "load, decide, write" with a single conditional `UPDATE ... WHERE used + $n <= limit` on one row, which removes the explicit lock at the cost of folding the per-request and plan checks into the same statement.
* Run the same script on a machine where the database is on its own host, to separate generator, service and database costs.