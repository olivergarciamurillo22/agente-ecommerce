# Product Intelligence production readiness

Result: **READY WITH BLOCKER**

Blocker: **META AD LIBRARY AUTHORIZATION**.

| Area | Assessment |
|---|---|
| Isolation | Ready; dependency direction is one-way and namespaced |
| Persistence | Ready for bounded Safe Test; atomic, locked, backed up |
| Failure recovery | Ready; corruption preserved and sessions checkpointed |
| Security | Ready; token stays in environment, payload/log redaction tested |
| Performance | Ready for Safe Test; clustering is the known scaling hotspot |
| Observability | Ready; provider health and sanitized operator state exposed |
| Provider | Implemented; real Meta authorization still pending |
| Auto Hunt | Manual Safe Test ready; recurring/24x7 deliberately disabled |

Safe defaults:

- `PRODUCT_INTELLIGENCE_ENABLED=false` fully disables the module.
- `AUTO_HUNT_ENABLED=false` is the independent kill switch and default.
- Meta is selected only after stored health is `META_CONNECTED`.
- Test fixtures cannot be selected by production API.
- No scheduler or permanent job exists.

Production promotion requires Node 22 full-suite execution, Meta approval, health `CONNECTED`, exact-query smoke test, manual Safe Test inspection and NAS disk observation.
