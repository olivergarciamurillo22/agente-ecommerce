# Meta Ad Library capability audit

Audit date: 2026-09-02

```text
Current Meta integration:
PARTIAL

Meta App detected:
YES

Ad Library API authorization:
MISSING

Existing credentials reusable:
PARTIAL

Required additional configuration:
- A Meta App authorized for the Ad Library API.
- A valid read-only access token in META_AD_LIBRARY_ACCESS_TOKEN.
- The Graph API version explicitly selected in META_GRAPH_API_VERSION.
- Confirmation that the app/token may query /ads_archive for the intended ad category and countries.
```

## Evidence

No Meta Marketing API SDK, Graph client, App ID, declared scope, token refresh system or Meta Ads account adapter exists in this checkout. A configured token reached Graph API v26.0 on 2026-09-02, but Meta returned `Application does not have permission for this action` for `/ads_archive`. The credential is therefore present but cannot currently authorize Ad Library research. Secret values were not recorded.

Files inspected:

- `package.json`
- `.env.example`, `.env.nas.example`, `.env.local` (key names only)
- `src/`, `scripts/`, `tests/` and `docs/` Meta-related references
- `src/lib/product-intelligence/*`

Files that will NOT be modified:

- WhatsApp/Baileys modules
- Shopify and supplier integrations
- Orders, tracking, economics, spend, campaign or statistics modules
- Existing database schema

## Safe behavior

`MetaAdLibraryProvider` is independent and disabled unless both required variables exist. Missing authorization produces an explicit unavailable status; it never generates fake ads. JSON import remains available. Responses preserve sanitized `rawProviderPayload` plus normalized fields, without tokens.

The provider supports exact search terms, configurable ES/PT/IT/FR/DE/EU country scope, pagination, per-cycle call budgets, timeouts, exponential retry, rate-limit detection and cooldown. Meta responses determine which requested fields are actually present; absent data remains absent.

Official references: [Ad Library API reference](https://developers.facebook.com/docs/marketing-api/reference/ads_archive/) and [Graph API rate limiting](https://developers.facebook.com/docs/graph-api/overview/rate-limiting/).
