Load test against http://api:3000 - 50 connections, 10s per scenario, 2026-10-17T18:13:44.265Z

| Scenario | req/s | p50 ms | p99 ms | max ms | 201 | 429 | 200 (replay) | errors | correctness |
|---|---|---|---|---|---|---|---|---|---|
| 1. one account, 50 users, all accepted | 102 | 494 | 726 | 745 | 1016 | 0 | 0 | 0 | OK |
| 2. 20 accounts x 10 users, all accepted | 376 | 120 | 278 | 451 | 3758 | 0 | 0 | 0 | OK |
| 3. account limit 406, requests >> limit | 105 | 468 | 647 | 689 | 406 | 647 | 0 | 0 | OK |
| 4. retry storm, 254 unique request ids | 189 | 254 | 465 | 478 | 254 | 0 | 1631 | 0 | OK |
