# Cloudflare Tunnel Default Variables Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the fixed Cloudflare Tunnel domain and Token matching defaults in Railway templates and direct `start.sh` execution while preserving explicit environment-variable overrides.

**Architecture:** Keep configuration in the two existing entry points: `template.json` supplies Railway template defaults, and `start.sh` supplies runtime fallbacks through POSIX `${VAR:-default}` expansion. No new dependencies or runtime components are introduced.

**Tech Stack:** JSON, POSIX `sh`, Node.js JSON validation

## Global Constraints

- Explicit non-empty environment variables must override the built-in defaults.
- `CLOUDFLARE_TUNNEL_DOMAIN` defaults to `go.chen9527.top`.
- `CLOUDFLARE_TUNNEL_TOKEN` defaults to the exact Token supplied in the approved request.
- Do not copy the real Token into `.env.example`, README, or new log output.
- Do not modify unrelated files or behavior.

---

### Task 1: Add matching template and runtime defaults

**Files:**
- Modify: `template.json:7-14`
- Modify: `start.sh:18-19`

**Interfaces:**
- Consumes: optional `CLOUDFLARE_TUNNEL_DOMAIN` and `CLOUDFLARE_TUNNEL_TOKEN` process environment variables
- Produces: non-empty `RAW_DOMAIN` and `RAW_TOKEN` shell variables, using explicit environment values first and built-in defaults otherwise

- [ ] **Step 1: Run a failing configuration assertion**

```bash
node - <<'NODE'
const fs = require('fs');
const template = require('./template.json');
const start = fs.readFileSync('./start.sh', 'utf8');
const expectedDomain = 'go.chen9527.top';
const expectedToken = 'eyJhIjoiYzYzYTFmNzAyYWUzNzJhZjkzYWVjNmFlZWFjNzcxNDAiLCJ0IjoiZGZkYzgwYzctMzRiNy00MzQ0LThhZGQtMjViYmY1YmI3YzMyIiwicyI6IlpESmxZemMxTm1VdE1HWTNOeTAwTTJNeExUaGhOVE10WkdJeE1EUTBaRFkzWTJZeSJ9';
if (template.variables.CLOUDFLARE_TUNNEL_DOMAIN.defaultValue !== expectedDomain) process.exit(1);
if (template.variables.CLOUDFLARE_TUNNEL_TOKEN.defaultValue !== expectedToken) process.exit(1);
if (!start.includes(`RAW_DOMAIN=\${CLOUDFLARE_TUNNEL_DOMAIN:-${expectedDomain}}`)) process.exit(1);
if (!start.includes(`RAW_TOKEN=\${CLOUDFLARE_TUNNEL_TOKEN:-${expectedToken}}`)) process.exit(1);
NODE
```

Expected: exit status `1`, because neither file contains the requested defaults yet.

- [ ] **Step 2: Add the Railway template defaults**

Change the two entries in `template.json` to:

```json
"CLOUDFLARE_TUNNEL_TOKEN": {
  "description": "【双隧道可选】Cloudflare Zero Trust 隧道 Token。不填则使用内置默认 Token。",
  "defaultValue": "eyJhIjoiYzYzYTFmNzAyYWUzNzJhZjkzYWVjNmFlZWFjNzcxNDAiLCJ0IjoiZGZkYzgwYzctMzRiNy00MzQ0LThhZGQtMjViYmY1YmI3YzMyIiwicyI6IlpESmxZemMxTm1VdE1HWTNOeTAwTTJNeExUaGhOVE10WkdJeE1EUTBaRFkzWTJZeSJ9"
},
"CLOUDFLARE_TUNNEL_DOMAIN": {
  "description": "【双隧道可选】固定隧道域名；不填则使用内置默认域名。",
  "defaultValue": "go.chen9527.top"
}
```

- [ ] **Step 3: Add the runtime fallbacks**

Change the corresponding `start.sh` assignments to:

```sh
RAW_DOMAIN=${CLOUDFLARE_TUNNEL_DOMAIN:-go.chen9527.top}
RAW_TOKEN=${CLOUDFLARE_TUNNEL_TOKEN:-eyJhIjoiYzYzYTFmNzAyYWUzNzJhZjkzYWVjNmFlZWFjNzcxNDAiLCJ0IjoiZGZkYzgwYzctMzRiNy00MzQ0LThhZGQtMjViYmY1YmI3YzMyIiwicyI6IlpESmxZemMxTm1VdE1HWTNOeTAwTTJNeExUaGhOVE10WkdJeE1EUTBaRFkzWTJZeSJ9}
```

- [ ] **Step 4: Run the configuration assertion again**

Run the command from Step 1 again.

Expected: exit status `0`.

- [ ] **Step 5: Verify syntax and override semantics**

```bash
sh -n start.sh
node -e "JSON.parse(require('fs').readFileSync('template.json', 'utf8'))"
CLOUDFLARE_TUNNEL_DOMAIN=custom.example CLOUDFLARE_TUNNEL_TOKEN=custom-token sh -c 'RAW_DOMAIN=${CLOUDFLARE_TUNNEL_DOMAIN:-go.chen9527.top}; RAW_TOKEN=${CLOUDFLARE_TUNNEL_TOKEN:-built-in}; test "$RAW_DOMAIN" = custom.example && test "$RAW_TOKEN" = custom-token'
git diff --check
```

Expected: every command exits with status `0` and produces no error output.

- [ ] **Step 6: Commit the implementation**

```bash
git add template.json start.sh
git commit -m "feat: add cloudflare tunnel variable defaults"
```
