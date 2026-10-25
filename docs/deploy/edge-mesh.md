# Edge Mesh — Global Service Topology

**Version**: v10.0.0 — edge-mesh  
**Date**: 2026-06-29

## Architecture

```
                          ┌──────────────────────┐
                          │   Cloudflare Global   │
                          │   Edge (330+ cities)  │
                          └──────┬───────┬───────┘
                                 │       │
              ┌──────────────────┘       └──────────────────┐
              ▼                                               ▼
┌─────────────────────────┐            ┌─────────────────────────┐
│   GCP Cloud Run (us)    │            │   OVH Bare Metal (eu)   │
│   kompress-ultra-api    │            │   milvus.peterl.dev     │
│   us-east1              │            │   npm.peterl.dev        │
│   auto-scale            │            │   Warsaw, Poland         │
│   Cloud Build trigger   │            │   16GB RAM, 4 vCore     │
└─────────────────────────┘            └─────────────────────────┘
         │                                        │
         │         ┌──────────────────┐            │
         └────────►│   Hetzner Fleet  │◄───────────┘
                   │   (7 machines)   │
                   │   €73.5/mo       │
                   │   DE + FI        │
                   └──────────────────┘
```

## Topology

| Layer | Provider | Region | Services | Cost |
|-------|----------|--------|----------|------|
| **Edge** | Cloudflare Workers | 330+ cities | API, MCP, badge, telemetry | ~$0 (free tier) |
| **Compute** | GCP (us-east1) | US | Cloud Build, Secret Manager, Artifact Registry | ~$5/mo |
| **Data** | OVH (WAW1) | Warsaw, EU | Milvus, Verdaccio, future models | ~€12/mo |
| **Fleet** | Hetzner | Nuremberg, Falkenstein, Helsinki | Runners, agents, CDN, benchmarks, services | €73.5/mo |

## Routing

```
User → Cloudflare Edge (closest PoP)
  ├── API:  api.kompress.vaked.dev       → Worker (global)
  ├── MCP:  api.kompress.vaked.dev/mcp   → Worker (global)
  ├── DB:   milvus.peterl.dev            → OVH Warsaw (EU)
  └── NPM:  npm.peterl.dev               → OVH Warsaw (EU)
```

### Verification status — 2026-10-25

The routing table above is the **declared** topology. It was checked against DNS
and HTTP on 2026-10-25, and most of it does not resolve. Keep the declaration,
but do not read it as a live map.

| host | declared | observed 2026-10-25 |
|------|----------|---------------------|
| `vaked.dev` | edge + worker routes | 200, Cloudflare (`172.67.72.122`) |
| `kompress.vaked.dev` | worker route `kompress.vaked.dev/*` | 200, but served by **GitHub Pages** (`185.199.108.153`), so the declared worker route is inert: an unproxied hostname never reaches the edge |
| `api.kompress.vaked.dev` | global API worker | **NXDOMAIN** |
| `eu.api.kompress.vaked.dev` | EU regional worker | **NXDOMAIN** |
| `asia.api.kompress.vaked.dev` | Asia regional worker | **NXDOMAIN** |
| `tears.vaked.dev` | worker route | **NXDOMAIN** |
| `weather.vaked.dev` | worker route | **NXDOMAIN** |
| `milvus.peterl.dev` | OVH Warsaw vector DB | **NXDOMAIN** |
| `npm.peterl.dev` | OVH Warsaw registry | resolves (`172.67.194.9`) but **HTTP 521**, origin unreachable |

Reproduce with:

```bash
python3 - <<'PY'
import socket, urllib.request
for h in ("api.kompress.vaked.dev", "eu.api.kompress.vaked.dev",
          "asia.api.kompress.vaked.dev", "tears.vaked.dev", "weather.vaked.dev",
          "milvus.peterl.dev", "npm.peterl.dev", "kompress.vaked.dev"):
    try:
        ip = socket.gethostbyname_ex(h)[2][0]
    except Exception:
        print(f"{h:32} NXDOMAIN"); continue
    try:
        st = urllib.request.urlopen(
            urllib.request.Request("https://" + h + "/",
                                   headers={"User-Agent": "edge-mesh-check"}), timeout=12).status
    except Exception as e:
        st = getattr(e, "code", type(e).__name__)
    print(f"{h:32} {ip:16} {st}")
PY
```

Consequence for the health-check block below: `curl -s https://api.kompress.vaked.dev/v1/health`
cannot succeed until an `api` record exists, and the `kompress.vaked.dev` route
cannot intercept traffic until that hostname is proxied through Cloudflare or
attached as a custom domain. Six of the eight hosts are unbound, so the 60s
dogfood check is green only if it is watching something other than this table.

## Health Check System

Every 60s, the dogfood CI workflow verifies all endpoints:

```bash
# Edge
curl -s https://api.kompress.vaked.dev/v1/health

# OVH
curl -s https://milvus.peterl.dev/health
curl -s https://npm.peterl.dev/-/ping

# Cloud Build
gcloud builds list --project=datapy-spider --limit=1

# Hetzner
hcloud server list
```

## Failover Strategy

| Failure | Fallback | RTO | RPO |
|---------|----------|-----|-----|
| OVH box down | Restore from age-encrypted secrets + Terraform | 30min | 24h |
| Cloudflare edge down | Direct to GCP Cloud Run | 5min | 0 |
| Hetzner runner down | GCP Cloud Build (direct) | 2min | 0 |
| GCP project down | Local builds + manual deploy | 1h | 24h |

## Cost Summary

| Component | Monthly | Annual |
|-----------|---------|--------|
| Hetzner fleet (7) | €73.50 | €882 |
| OVH (Warsaw) | ~€12.00 | ~€144 |
| GCP (datapy-spider) | ~$5.00 | ~$60 |
| Cloudflare Workers | Free | Free |
| DNS (vaked.dev) | Free | Free |
| **Total** | **~€90/mo** | **~€1,086/yr** |
