---
title: "Debugging a flaky Postgres index"
source: "https://chatgpt.com/c/68ad1f42-3c7a-4e19-9f0b-2c1d5a6e8b30"
model: "gpt-4o"
created: 2025-08-26T09:20:00Z
updated: 2025-08-26T13:10:00Z
messages: 2
exported: 2026-11-10T06:04:36Z
exported_with: "Chat2MD v0.1.0"
---

# Debugging a flaky Postgres index

## You

This query got 40x slower after we added a partial index. Why would the planner ignore it?

```sql
SELECT id, status FROM orders
WHERE tenant_id = $1 AND status = 'pending'
ORDER BY created_at DESC
LIMIT 50;
```

## ChatGPT

The planner is almost certainly rejecting the partial index because the predicate is not *provably* implied by the query.

| Symptom | Likely cause |
| --- | --- |
| Index never chosen | Predicate not provable at plan time |
| Chosen, still slow | Missing `created_at` for the sort |

Two things to check:

1. The index predicate must be a literal match. If you declared it as
   `WHERE status = 'pending'::order_status` but pass a `text` parameter, the
   implication test fails silently.
2. Your `ORDER BY created_at DESC LIMIT 50` needs the sort column *in the index*,
   otherwise Postgres still has to sort the whole matched set:

```sql
CREATE INDEX CONCURRENTLY orders_pending_recent
  ON orders (tenant_id, created_at DESC)
  WHERE status = 'pending';
```

The cost model is roughly $O(n \log n)$ for the sort you are paying for now, versus
$O(\log n)$ for an index scan that is already ordered.
