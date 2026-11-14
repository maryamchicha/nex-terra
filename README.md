# NEX TERRA — Rotation Resilience Engine

Agricultural decision-support for Moroccan farmers. Simulates crop
rotations against satellite-derived soil + climate data and ranks
alternatives. A three-step demo: **pick a field**, **simulate a rotation**,
**compare / optimize** under future climate scenarios.

Built with:

* **Backend**: FastAPI + Uvicorn, Python 3.13 (`nex_terra/back/`)
* **Frontend**: Vite + React + Leaflet (`nex_terra/front/`)
* **Data**: NASA POWER / GPM / MODIS / SMAP / NEX-GDDP-CMIP6, with a
  deterministic synthetic fallback so the demo works fully offline.

---

## Run it

### 1. Start the backend

```bash
cd nex_terra/back
./venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000
```

The first boot takes a few seconds. Health:

```bash
curl http://127.0.0.1:8000/health
# {"status":"ok","service":"nex-terra","engine":"rotation-simulator"}
```

> The port 8000 must be free. If you see `ERROR: [Errno 98] address
> already in use`, kill the process holding it (see
> [port-in-use troubleshooting](#port-8000-address-already-in-use)) and
> retry.

### 2. Start the frontend

```bash
cd nex_terra/front
npm run dev
```

Then open **http://localhost:5173** in a browser.

> To use the minified production build instead, the backend serves
> `nex_terra/front/dist/` at `/` when it exists.

---

## NASA data

The backend returns a `nasa` object in the `simulate`, `compare`, and
`demo_seed` responses, built from real NASA sources (POWER, GPM, MODIS,
SMAP, NEX-GDDP-CMIP6). If the live endpoints are unreachable (typical in
restricted/offline networks), it falls back to a **deterministic synthetic
series** and marks it with `_synthetic: true` and `source_note`.

The fallback is cached to `nex_terra/back/data/nasa/composite_nasa.json`
so subsequent calls are ~0.02 s and the demo is fully offline-capable after
the first pull:

```bash
# force a fresh pull
rm -rf nex_terra/back/data/nasa
```

---

## API overview

| Endpoint | Method | Purpose |
|---|---|---|
| `/health` | GET | Service health |
| `/api/field` | GET | Demo field (Settat, lat 32.75, lon -8.05) |
| `/api/soil` | GET | SoilGrids-like soil profile |
| `/api/history` | GET | Past rotations (demo archive) |
| `/api/scenarios` | GET | Future climate scenarios (4) |
| `/api/simulate` | POST `{"crops":[...]}` | Simulate one rotation under one scenario |
| `/api/compare` | POST `{"crops":[...]}` | Compare ≥3 rotations across scenarios, rank |
| `/api/optimize` | POST `{"crops":[...]}` | Engine recommendation |
| `/api/demo/seed.json` | GET | Deterministic frontend seed data (includes `nasa`) |

Example `simulate` request:

```json
{
  "crops": ["winter_wheat", "faba_beans", "winter_wheat"],
  "soil": { "soil_type": "loam", "sand_pct": 42, "silt_pct": 43, "clay_pct": 15, "ph": 8.1, "organic_c_pct": 0.9, "nacl_ppth": 6 },
  "climate": { "id": "baseline", "temp_shift": 0, "precipitation": 1, "drought": 0 }
}
```

All numeric fields are deterministic (no randomness).

## Port 8000 — address already in use

If you get:

```
ERROR: [Errno 98] address already in use
```

find and kill the holder:

```bash
# find the PID
ss -tlnp 2>/dev/null | grep :8000
# or
pgrep -af "uvicorn app.main"

# kill it
kill -9 <PID>
```

Then retry. This commonly happens when a previous backend process was
left running from an earlier session.

---

