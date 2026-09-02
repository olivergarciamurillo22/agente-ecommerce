# Product Intelligence performance baseline

Date: 2026-09-02. Runtime: Node 24.19.0 on the development workstation. No Meta calls.

Synthetic dataset: 10,000 ads, 500 advertisers, 1,000 products and 5,000 queries.

| Stage | Result |
|---|---:|
| Dataset generation | 11 ms |
| Ingestion, clustering, deduplication and product scoring | 6,892 ms |
| Query scoring | 1 ms |
| Atomic persistence | 12 ms |
| JSON report generation | 17 ms |
| Total | 6,933 ms |
| Heap delta | 30 MB |

Result: PASS for bounded Safe Test cycles. The obvious hotspot is conservative product clustering, currently quadratic over candidate product groups. It is acceptable for the configured 5-query Safe Test but should be indexed by fingerprint before large recurring runs. Raw payloads are referenced once per normalized ad during a run and are not cloned by scoring. No 24/7 job is enabled.

Snapshot policy: append daily snapshots, never delete automatically in this phase. Future retention should keep daily data for 90 days, weekly aggregates for one year and archive older data after measuring real growth. The current JSON store is appropriate only for bounded runs.

Logging policy: INFO for run summaries, DEBUG for individual queries, ERROR for sanitized failures. Product Intelligence does not configure or alter the global logger.
