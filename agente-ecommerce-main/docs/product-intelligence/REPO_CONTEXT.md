# Product Intelligence — repository context

Last updated: 2026-09-02  
Working branch: `pedro-atuomatizacion-research`

## Current state

The Winning Product Intelligence Engine is implemented as an isolated, read-only module. It supports manual seed research, bounded Auto Hunt Safe Test, query expansion, conservative product clustering, advertiser deduplication, scoring, confidence, lifecycle, snapshots, diffs, signals, watchlist, JSON exports and checkpointed sessions.

Production readiness is **READY WITH BLOCKER**.

The only functional blocker is Meta Ad Library authorization. The token and Graph API v26.0 configuration reach Meta, but `/ads_archive` currently returns `Application does not have permission for this action`. The provider translates this into `META_CONFIGURED_UNAUTHORIZED` and never invents results.

## Safety state

```text
PRODUCT_INTELLIGENCE_ENABLED=true
AUTO_HUNT_ENABLED=false
Meta authorization=PENDING
Auto Hunt 24/7=OFF
```

Product Intelligence does not create, edit or pause campaigns. It does not modify Meta Ads account data, economics, WhatsApp, Shopify, orders, suppliers or tracking.

Secrets live only in ignored environment files. Never commit or print `META_AD_LIBRARY_ACCESS_TOKEN`, authorization headers, cookies or app secrets.

## Architecture

- Core namespace: `src/lib/product-intelligence/`
- API: `src/app/api/product-intelligence/`
- Dashboard: `src/components/ProductIntelligencePanel.tsx`
- CLI: `scripts/product-intelligence.ts`
- Persistent state: `/app/data/product-intelligence*.json`
- NAS host state: `${PERSIST_DIR}/data`
- Product Intelligence backups: `${PERSIST_DIR}/backups/product-intelligence`

Persistence uses a lock file, backup, temporary file, `fsync` and atomic rename. Corrupt JSON is preserved with a timestamp and is not silently overwritten.

## Operator commands

```text
npm run product-intelligence -- meta-health
npm run product-intelligence -- meta-smoke-test "almohada cervical"
npm run product-intelligence -- persistence-health
npm run product-intelligence -- export dossiers
npm run product-intelligence -- export watchlist
npm run product-intelligence -- export daily
npm run product-intelligence -- reset-test-data
npm run backup:product-intelligence
npm run test:product-intelligence
npm run typecheck
npm run build
```

The repository pins Node 22 through `.nvmrc`. Use Node 22 for the complete historical suite. Node 24 on the current Windows workstation has a known `tsx/thread-stream` loader incompatibility; dependencies were deliberately left unchanged.

## Validation baseline

```text
Product Intelligence tests: 36 PASS
TypeScript:                 PASS
Next.js production build:  PASS
Persistence health:        PASS
Backup rehearsal:          PASS
```

Synthetic performance baseline: 10,000 ads, 500 advertisers, 1,000 products and 5,000 queries processed in approximately 6.93 seconds with a 30 MB heap delta. Conservative clustering is the known scaling hotspot but is acceptable for Safe Test budgets.

## After Meta approval

1. Generate a fresh token.
2. Replace `META_AD_LIBRARY_ACCESS_TOKEN` in the NAS environment.
3. Restart the agent.
4. Run `meta-health` and require `META_CONNECTED`.
5. Run the exact-query smoke test with `almohada cervical`.
6. Inspect normalized real results.
7. Enable Auto Hunt Safe Test manually.
8. Review scoring, persistence and NAS resources.
9. Keep recurring Auto Hunt disabled until a separate approved phase.

## Key documents

- `META_AD_LIBRARY_CAPABILITY.md`
- `AFTER_META_APPROVAL.md`
- `ISOLATION_AUDIT.md`
- `PERFORMANCE.md`
- `TEST_MATRIX.md`
- `PRODUCTION_READINESS.md`
- `NAS_DEPLOYMENT.md`

## Collaboration note

Oliver may be modifying other parts of the repository in parallel. Preserve concurrent changes and avoid refactoring outside the Product Intelligence namespace. Existing operational modules remain authoritative for their own domains.
