# Default Both Backends Implementation Plan

**Goal:** Run Node and Railway Xray concurrently by default while retaining single-backend overrides and old Node links.

- [x] Add a failing default-both subscription test; retain explicit Node regression tests.
- [x] Add the both selector and represent subscription variants by backend, protocol and WS path.
- [x] Route only `/` to the Node noServer WS server; retain credential validation for Rust paths and strict unknown-path rejection.
- [x] Close both WS servers and Rust during shutdown.
- [x] Update Docker, shell, template, env example and docs to default both.
- [x] Verify default Node TCP/UDP/XUDP alongside Rust relaying, plus single-backend regressions.
- [x] Run real upstream and offline shell checks; independently review the changes.
- [x] Prepare the verified implementation for commit and publication to the existing GitHub main branch.

Verification: 50/50 npm tests passed; real pinned AMD64 binary passed the isolated default-both subscriptions, Node TCP/UDP, Rust TCP variants and SIGTERM checks; five offline start.sh checks passed. Independent code review passed. Docker build and live Railway/Cloudflare connectivity remain unverified.
