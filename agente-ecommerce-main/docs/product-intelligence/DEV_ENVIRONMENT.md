# Product Intelligence development environment

The repository pins Node `22` in `.nvmrc`. `package.json` accepts Node `>=20.9.0`, but contributors and CI should use Node 22 because it is the explicit project version.

The current workstation runs Node 24.19.0. Under this version the historical `tsx` suite can fail before application tests with `uv_os_get_passwd ENOMEM` or an invalid JSON loader error involving `thread-stream`. Product Intelligence tests were executed with a process-local loader workaround; dependencies and global Node were not changed.

Recommended sequence:

```text
nvm use 22
npm ci
npm test
npm run test:product-intelligence
npm run typecheck
npm run build
```

Do not change dependencies to hide a runtime mismatch. Align Node with `.nvmrc` first.
