# Product Intelligence isolation audit

Date: 2026-09-02. Result: PASS.

## Classification

`NEW_PRODUCT_INTELLIGENCE`: every file under `src/lib/product-intelligence/`, both Product Intelligence API routes, its CLI, tests, fixtures and all documents in this directory. These files have no inbound dependency from orders, WhatsApp, suppliers, Shopify, campaigns, statistics or economics.

`UI_INTEGRATION`: `src/components/ProductIntelligencePanel.tsx` is new. `Dashboard.tsx` only imports/renders that panel for the new view. `DashboardHeader.tsx` only adds the `products` navigation value and label. Existing default view remains Orders.

`CONFIG_INTEGRATION`: `.env.example` adds namespaced, opt-in Product Intelligence variables. `.env.local` contains runtime-only configuration and is Git-ignored. `package.json` adds isolated CLI/test scripts; no existing script changed.

`SAFE_EXISTING_EXTENSION`: none of the existing operational libraries were extended.

`POTENTIAL_RISK`: Product Intelligence research runs in an HTTP request and uses synchronous local JSON persistence. Safe Test budgets bound execution, atomic writes prevent corruption, and the feature flag isolates it. Before recurring 24/7 execution, move cycles to an explicitly controlled worker/job and load-test the NAS disk.

## Existing files changed

- `Dashboard.tsx`: new Products branch only; no changes to Orders/Chats/System/Settings behavior. Low regression risk.
- `DashboardHeader.tsx`: new navigation item/type only. Low regression risk.
- `.env.example`: documentation/defaults only. No runtime behavior.
- `package.json`: two new commands only. No existing command changed.

## Dependency direction

Product Intelligence depends only on Node primitives, Next route/UI boundaries and its own namespace. Meta Ads, economics, campaigns, WhatsApp and orders do not import Product Intelligence. Meta Ad Library is a separate read-only provider and never calls campaign/account endpoints.

Confirmed unchanged: existing Meta Ads, economics, campaigns, WhatsApp and orders.
