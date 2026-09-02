# After Meta approval

1. Generate fresh token.
2. Replace META_AD_LIBRARY_ACCESS_TOKEN.
3. Restart agent.
4. Run meta-health.
5. Verify CONNECTED.
6. Run smoke test: "almohada cervical"
7. Inspect normalized results.
8. Run Auto Hunt SAFE TEST.
9. Inspect scoring.
10. Only then consider enabling recurring Auto Hunt.

Commands:

```text
npm run product-intelligence -- meta-health
npm run product-intelligence -- meta-smoke-test "almohada cervical"
```

Auto Hunt remains manual and disabled while authorization is not `META_CONNECTED`. Token rotation requires no code changes.
