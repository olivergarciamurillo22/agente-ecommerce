# Product Intelligence test matrix

| Area | Status | Evidence |
|---|---|---|
| Provider | PASS | exact query, pagination, zero/missing data fixtures |
| Provider failures | PASS | timeout, 401, 403, 429 and 500 classified safely |
| Queries | PASS | normalization, exact root, scoring and bounded children |
| Clustering | PASS | Hallux alias confidence and conservative threshold |
| Scoring | PASS | 500 randomized invariant cases; explainability total |
| Lifecycle | PASS | EMERGING, SCALING, VALIDATED, SATURATING, DECLINING |
| Snapshots | PASS | append-only persistence |
| Diff | PASS | new/removed ad, advertiser, spike and lifecycle events |
| Signals | PASS | unchanged observations produce no repeated signal |
| Persistence | PASS | lock, backup, fsync, atomic rename |
| Recovery | PASS | corrupt file preserved with timestamp |
| Feature off | PASS | provider is not called and no research is created |
| Security | PASS | raw payload sanitization and log redaction |
| UI | PASS | production build and API state verified |
| Performance | PASS | 10k/500/1k/5k benchmark |
| Historical project suite | NOT TESTED | Node 24/tsx incompatibility; use Node 22 |
