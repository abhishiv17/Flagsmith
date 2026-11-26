# 10: Aiven Setup (Owner: Role B)

## 1. What's provisioned (21 Nov 2026)

Project **`stockhop`** · Aiven trial ($50 credits, 30 days, **no card**) · all **Developer tier**

| Service | Name | Version | Cloud / region | Plan | ~Cost |
|---|---|---|---|---|---|
| PostgreSQL | `stockhop-pg` | PG 18 | DigitalOcean `sgp` (Singapore) | Developer-1: 1 CPU / 1 GB / 8 GB, **15 connections** | $5/mo |
| Apache Kafka | `stockhop-kafka` | Kafka 4.3 | DigitalOcean `blr` (**Bengaluru**) | Developer-2-1d: 1 MB/s, ≤ 20 topics, 1-day retention, 2 nodes | $35/mo |
| OpenSearch | `stockhop-os` | OpenSearch 3.6 | DigitalOcean `sgp` (Singapore) | Developer-4-30: 2 CPU / 4 GB / 30 GB | $40/mo |

≈ $80/mo ≈ **$2.70/day** of credit. Developer services are **not powered off when idle** (unlike Free), which is why we chose them (ADR-12). The Developer tier doesn't allow picking an exact region; Aiven assigned these.

IP allowlist: open to all (default), which is fine for the hackathon. After the event, power off or delete the services.

## 2. Team access

Aiven console → **Admin → Users** → invite teammates by email to the organization, then grant access to project `stockhop`. Never share the owner's login.

## 3. Topics (create in console → stockhop-kafka → Topics)

| Topic | Partitions | Replication | Retention |
|---|---|---|---|
| `orders.placed` | 2 | default | default (1 day) |
| `inventory.changed` | 2 | default | default |
| `smoke` | 1 | default | default |

## 4. Credentials → local files (never committed)

| Where in console | Goes to |
|---|---|
| stockhop-pg → Overview → **Service URI** | `.env` `DATABASE_URL` (the code strips `?sslmode=require`) |
| stockhop-pg → **CA certificate** | `certs/pg-ca.pem` |
| stockhop-kafka → Overview → Authentication **Client certificate** → **Service URI** (host:port) | `.env` `KAFKA_BROKER` |
| stockhop-kafka → **CA certificate**, **Access certificate**, **Access key** | `certs/kafka-ca.pem`, `certs/kafka-service.cert`, `certs/kafka-service.key` |
| stockhop-os → Overview → **Service URI** (`https://avnadmin:…@host:port`) | `.env` `OPENSEARCH_URL` |

Share `.env` + `certs/` with teammates via a **private** DM/zip only.

**On Vercel** (no files): paste the PG CA PEM text into the `PG_CA_CERT` env var. The API needs only `DATABASE_URL`, `PG_CA_CERT`, `OPENSEARCH_URL`, `ADMIN_TOKEN`, `PG_POOL_MAX=5`. Kafka secrets stay on the worker host.

## 5. Client gotchas

- **PostgreSQL (`pg`)**: `?sslmode=require` in the URI conflicts with an explicit `ssl` object in newer `pg`. `server/config.ts` strips it and passes `ssl: { ca }`.
- **Connection limit 15**: `PG_POOL_MAX=5` per process. Workers (1 process) + local API + a couple of Vercel instances fit. Watch it during the stampede.
- **Kafka (`kafkajs`)**: mTLS with CA + access cert + key. Producer is *not* `idempotent: true` (extra ACLs); consumers are idempotent instead.
- **OpenSearch**: credentials are in the URI; Aiven uses a publicly trusted CA.
- **Ports**: Aiven uses non-standard ports (e.g. 26527, 26540). **Test on the venue Wi-Fi.** If blocked, use a phone hotspot.

## 6. Morning-of-judging check (07:00 and T-30 min)

1. Aiven console → all three **Running**.
2. `npm run smoke` ✅✅✅
3. `npm run demo:reset` → `/ops` 90/90 in sync, all worker heartbeats green.

## 7. Reference: free-tier limits (what we avoided by using Developer)

Free Kafka: 5 topics × 2 partitions, ~250 KiB/s. Free OpenSearch: 2 shards, powers off after ~24 h idle. Free PG: may power off when inactive.
Sources: [Kafka free tier](https://aiven.io/docs/products/kafka/free-tier/kafka-free-tier) · [OpenSearch free tier](https://aiven.io/docs/products/opensearch/concepts/opensearch-free-tier) · [Free plans](https://aiven.io/docs/platform/concepts/free-plan)
