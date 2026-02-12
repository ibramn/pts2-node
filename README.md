## pts2-node

Node.js/TypeScript client for the PTS-2 device `jsonPTS` protocol, plus:
- **CLI** (similar to `Technotrade.PTS2.NETCoreTestAppPortable`)
- **REST API** (Express)

### Setup

```bash
cd pts2-node
npm install
cp .env.example .env
```

Edit `.env` (host, auth, TLS options).

### Run CLI

```bash
npm run dev:cli -- test
```

If you see a config error, create `.env` from `.env.example` and set `PTS2_HOST` (plus auth/ports as needed).

### Run REST API

```bash
npm run dev:server
```

Then:
- `GET http://localhost:3000/health`
- `GET http://localhost:3000/datetime`
- `POST http://localhost:3000/report/pump-transactions`

Example body:

```json
{ "pump": 0, "from": "2026-02-12T00:00:00", "to": "2026-02-12T23:59:59" }
```

