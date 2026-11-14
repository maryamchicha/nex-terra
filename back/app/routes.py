"""NEX TERRA API routes."""

import json
import logging
import time
from pathlib import Path
from statistics import mean
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Request

from . import config as _cfg, models
from .models import (FieldResult, FieldUpdate, OptimizationResult,
                     RotationRequest, RotationResult, ScenariosResult)
from .simulator import simulator as sim

router = APIRouter(tags=["nex-terra"])

log = logging.getLogger("nex-terra")

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
FIELD_JSON = DATA_DIR / "field.json"

# The three rotations compared by the engine. Crop names are the ones already
# used in the history data, so the simulator knows them.
ROTATIONS: Dict[str, Dict[str, Any]] = {
    "A": {"label": "A. Continuous cereal",
          "crops": ["winter_wheat", "winter_wheat", "winter_wheat"]},
    "B": {"label": "B. Cereal–legume rotation",
          "crops": ["winter_wheat", "faba_beans", "winter_wheat"]},
    "C": {"label": "C. Diversified rotation",
          "crops": ["winter_wheat", "faba_beans", "sunflower"]},
}

# Used only when live NASA data cannot be fetched. Always flagged synthetic.
_NASA_FALLBACK: Dict[str, Any] = {
    "temp_mean_c": 16.8,
    "rainfall_mm_tot": 0.0,  # TODO: placeholder, check the unit the engine expects
    "sun_hours": 5.0,
    "humidity_pct": 45.0,
    "evi": 0.42,
    "sm": 0.30,
    "cmip6": {"temp_mean_c": 18.6, "precipitation_mm": 0.0},
    "_synthetic": True,
    "source_note": "Synthetic fallback series: live NASA data unavailable.",
}

_NASA_TTL_REAL = 24 * 3600   # keep real data for 24 h
_NASA_TTL_FALLBACK = 300     # retry real data after 5 min
_nasa_cache: Dict[str, Any] = {"ts": 0.0, "ttl": 0.0, "data": None}


# --------------------------------------------------------------------------- #
#  Helpers
# --------------------------------------------------------------------------- #
def _load_field_json() -> Dict[str, Any]:
    try:
        with open(FIELD_JSON, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _soil_default() -> Dict[str, Any]:
    try:
        with open(DATA_DIR / "soilgrids.json", encoding="utf-8") as f:
            data = json.load(f)
        return {k: v for k, v in data.items() if k != "field_code"}
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _build_soil_profile(soil: Optional[Dict[str, Any]]) -> sim.SoilProfile:
    p = _soil_default()
    if soil:
        for k, v in soil.items():
            if k in p:
                p[k] = v
    return sim.build_soil_profile(p)


def _default_climate() -> Dict[str, Any]:
    return {"temp_shift": 0.0, "precipitation": 1.0, "drought": 0.0}


def _demo_field() -> Dict[str, Any]:
    """Demo field for the frontend, built from data/field.json."""
    raw = _load_field_json()
    return {
        "id": raw.get("field_code", "SET-001"),
        "name": raw.get("name", "Settat demo field"),
        "region": raw.get("region", "Settat region, Morocco"),
        "lat": raw.get("lat", 32.75),
        "lon": raw.get("lon", -8.05),
        "area_ha": raw.get("area_ha", 10.0),
        "terrain": raw.get("terrain", "flat"),
        "irrigation": raw.get("irrigation", "rainfed"),
        "soil": _soil_default(),
    }


def _nasa_payload() -> Dict[str, Any]:
    """NASA observations for the demo field, cached in memory.

    Real data is kept 24 h. If the live fetch fails (or the client itself
    falls back to synthetic data), we retry after 5 minutes.
    """
    now = time.time()
    if _nasa_cache["data"] is not None and now - _nasa_cache["ts"] < _nasa_cache["ttl"]:
        return _nasa_cache["data"]

    field = _demo_field()
    try:
        from .nasa.client import fetch_nasa_series
        data = fetch_nasa_series(field["lat"], field["lon"], 2019, 2024)
    except Exception as exc:  # noqa: BLE001 - keep the demo online no matter what
        log.warning("nasa payload unavailable: %s", exc)
        data = dict(_NASA_FALLBACK)

    ttl = _NASA_TTL_FALLBACK if data.get("_synthetic") else _NASA_TTL_REAL
    _nasa_cache.update(ts=now, ttl=ttl, data=data)
    return data


# --------------------------------------------------------------------------- #
#  GET /api/field
# --------------------------------------------------------------------------- #
@router.get("/field", response_model=FieldResult)
def get_field():
    """Virtual field selection: returns the Settat demo field."""
    raw = _load_field_json()
    if not raw:
        raise HTTPException(404, "No virtual field seed (data/field.json)")
    return FieldResult(
        field_code=raw.get("field_code", "SET-001"),
        name=raw.get("name", "Demo field"),
        region=raw.get("region", ""),
        lat=raw.get("lat", 32.75),
        lon=raw.get("lon", -8.05),
        area_ha=raw.get("area_ha", 10.0),
        terrain=raw.get("terrain", "flat"),
        irrigation=raw.get("irrigation", "rainfed"),
        soil=raw.get("soil", {}),
        previous_crops=raw.get("previous_crops", ["winter_wheat"]),
    )


# --------------------------------------------------------------------------- #
#  PUT /api/field   (stateless: nothing is written to the server)
# --------------------------------------------------------------------------- #
@router.put("/field", response_model=FieldResult)
def update_field(payload: FieldUpdate):
    """Echo the farmer's field choices. Not persisted: the API is public and
    the demo field is shared by all visitors."""
    return FieldResult(
        field_code=payload.field_code,
        name="Custom field",
        region=payload.region,
        lat=payload.lat,
        lon=payload.lon,
        area_ha=payload.area_ha,
        terrain=payload.terrain,
        irrigation=payload.irrigation,
        soil={},
        previous_crops=list(payload.previous_crops),
    )


# --------------------------------------------------------------------------- #
#  GET /api/soil
# --------------------------------------------------------------------------- #
@router.get("/soil", responses={200: {"model": Dict[str, Any]}})
def get_soil():
    """SoilGrids-like soil properties for the selected field."""
    return _soil_default()


# --------------------------------------------------------------------------- #
#  GET /api/history
# --------------------------------------------------------------------------- #
@router.get("/history", response_model=List[Dict[str, Any]])
def get_history():
    """Past rotations for the field (demo archive)."""
    return [
        {"year": 2021, "rotation": ["winter_wheat", "winter_wheat"],
         "water_mm": 781.2, "n_kg": -66.6, "score": 0.597},
        {"year": 2022, "rotation": ["winter_wheat", "faba_beans", "winter_wheat"],
         "water_mm": 796.8, "n_kg": -74.8, "score": 0.600},
        {"year": 2023, "rotation": ["winter_wheat", "alfalfa", "sunflower"],
         "water_mm": 790.8, "n_kg": -67.4, "score": 0.574},
        {"year": 2024, "rotation": ["winter_wheat", "winter_wheat", "winter_wheat"],
         "water_mm": 781.2, "n_kg": -66.6, "score": 0.597},
        {"year": 2025, "rotation": ["winter_wheat", "faba_beans", "sunflower"],
         "water_mm": 805.1, "n_kg": -71.2, "score": 0.585},
    ]


# --------------------------------------------------------------------------- #
#  POST /api/simulate
# --------------------------------------------------------------------------- #
@router.post("/simulate", response_model=RotationResult)
def simulate(payload: RotationRequest, request: Request):
    """Simulate one crop rotation under one climate state."""
    rotator = request.app.state.rotator
    soil = _build_soil_profile(payload.soil)
    climate = payload.climate or _default_climate()
    nasa = _nasa_payload()
    crops = payload.crops or list(ROTATIONS["A"]["crops"])

    try:
        res = rotator.score_rotation(crops, soil, climate, nasa=nasa)
    except (KeyError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=f"Invalid rotation: {exc}") from exc

    return RotationResult(
        id=climate.get("id", "default"),
        rotations=res["rotations"],
        rotation=res["rotation"],
        name=models._weather_label(climate),
        water_total_mm=res["water_total_mm"],
        water_avg_mm=res["water_avg_mm"],
        water_cap_factor=res["water_cap_factor"],
        n_balance_kg=res["n_balance_kg"],
        n_balance_per_season_kg=res["n_balance_per_season_kg"],
        resilience_avg=res["resilience_avg"],
        soil_protection_avg=res["soil_protection_avg"],
        economic_potential_avg=res["economic_potential_avg"],
        econ_per_water_mad_m3=res["econ_per_water_mad_m3"],
        score=res["score"],
        seasons=res["seasons"],
        nasa=res["nasa"],
    )


# --------------------------------------------------------------------------- #
#  GET /api/scenarios
# --------------------------------------------------------------------------- #
@router.get("/scenarios", response_model=ScenariosResult)
def list_scenarios():
    """Future climate scenarios (NEX-GDDP-CMIP6 deltas)."""
    return ScenariosResult(scenarios=_cfg.config.scenarios)


# --------------------------------------------------------------------------- #
#  POST /api/compare
# --------------------------------------------------------------------------- #
@router.post("/compare", response_model=Dict[str, Any])
def compare(payload: RotationRequest, request: Request):
    """Compare rotations A / B / C under every climate scenario.

    Returns:
        - comparison: one row per (rotation, scenario)
        - ranked: rotations ranked by mean score across scenarios
        - climate_flip: scenarios where the winning rotation changes
    """
    rotator = request.app.state.rotator
    soil = _build_soil_profile(payload.soil)
    nasa = _nasa_payload()

    scenarios = list(_cfg.config.scenarios)
    if not scenarios:
        raise HTTPException(500, "No climate scenarios configured")

    rotations = {rid: dict(r) for rid, r in ROTATIONS.items()}
    # A rotation sent by the client that is not A/B/C is added as "D"
    custom = list(payload.crops) if payload.crops else None
    if custom and custom not in [r["crops"] for r in rotations.values()]:
        rotations["D"] = {"label": "D. Custom rotation", "crops": custom}

    comparison: List[Dict[str, Any]] = []
    try:
        for rid, rot in rotations.items():
            for sc in scenarios:
                res = rotator.score_rotation(rot["crops"], soil, sc, nasa=nasa)
                comparison.append({
                    "rotation_id": rid,
                    "rotation_label": rot["label"],
                    "rotation": list(res["rotation"]),
                    "scenario_id": sc.get("id", "default"),
                    "label": sc.get("label", "baseline"),
                    "temp_shift": sc.get("temp_shift", 0.0),
                    "precipitation": sc.get("precipitation", 1.0),
                    "drought": sc.get("drought", 0.0),
                    "water_total_mm": res["water_total_mm"],
                    "n_balance_kg": res["n_balance_kg"],
                    "resilience_avg": res["resilience_avg"],
                    "soil_protection_avg": res["soil_protection_avg"],
                    "economic_potential_avg": res["economic_potential_avg"],
                    "econ_per_water_mad_m3": res["econ_per_water_mad_m3"],
                    "score": res["score"],
                })
    except (KeyError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=f"Invalid rotation or scenario: {exc}") from exc

    # ---- overall ranking: mean score across scenarios (stability) ----------
    ranked: List[Dict[str, Any]] = []
    for rid, rot in rotations.items():
        rows = [c for c in comparison if c["rotation_id"] == rid]
        scores = [float(r["score"]) for r in rows]
        ranked.append({
            "id": rid,
            "label": rot["label"],
            "rotation": rot["crops"],
            "mean_score": round(mean(scores), 4),
            "worst_score": round(min(scores), 4),
            "water_mm": round(mean(float(r["water_total_mm"]) for r in rows), 1),
        })
    ranked.sort(key=lambda r: r["mean_score"], reverse=True)
    for i, r in enumerate(ranked, start=1):
        r["rank"] = i

    # ---- winner per scenario, and where the winner flips -------------------
    winners: Dict[str, str] = {}
    for sc in scenarios:
        sid = sc.get("id", "default")
        in_sc = [c for c in comparison if c["scenario_id"] == sid]
        winners[sid] = max(in_sc, key=lambda c: c["score"])["rotation_id"]

    base_id = "historical" if "historical" in winners else next(iter(winners))
    flipping = [sid for sid, w in winners.items() if w != winners[base_id]]
    if flipping:
        climate_flip = {
            "baseline_scenario": base_id,
            "baseline_winner": winners[base_id],
            "flipping_scenarios": flipping,
            "winners": winners,
        }
    else:
        climate_flip = {"note": "No scenario changes the winning rotation.",
                        "winners": winners}

    return {
        "rotations": {rid: r["crops"] for rid, r in rotations.items()},
        "rotation_names": {rid: r["label"] for rid, r in rotations.items()},
        "comparison": comparison,
        "ranked": ranked,
        "climate_flip": climate_flip,
        "scenario_ids": [s.get("id", "default") for s in scenarios],
        "scenarios": scenarios,
        "nasa": nasa,
    }


# --------------------------------------------------------------------------- #
#  POST /api/optimize
# --------------------------------------------------------------------------- #
@router.post("/optimize", response_model=OptimizationResult)
def optimize(request: Request, payload: Optional[RotationRequest] = None):
    """Search for the rotation that best satisfies the priorities
    (water, nitrogen, resilience, soil, economy) under a climate scenario."""
    rotator = request.app.state.rotator
    soil = _build_soil_profile(payload.soil if payload else None)
    climate = (payload.climate if payload and payload.climate else None) or _default_climate()

    # TODO: priorities are fixed; accepting them from the client needs a model change
    priorities = {"water": 0.20, "nitrogen": 0.15, "resilience": 0.25,
                  "soil": 0.20, "economy": 0.20}
    s = sum(priorities.values()) or 1.0
    priorities = {k: v / s for k, v in priorities.items()}

    res = rotator.optimize(soil, climate, priorities, max_seasons=3, water_cap_mm=None)
    return OptimizationResult(**res)


# --------------------------------------------------------------------------- #
#  GET /api/nasa
# --------------------------------------------------------------------------- #
@router.get("/nasa")
def api_nasa():
    """Satellite + climate-model observations for the demo field.

    Real NASA data when reachable; otherwise a series flagged
    `_synthetic: true` with a `source_note`."""
    return _nasa_payload()


# --------------------------------------------------------------------------- #
#  GET /api/demo/seed.json
# --------------------------------------------------------------------------- #
@router.get("/demo/seed.json", response_model=Dict[str, Any])
def demo_seed():
    """Seed data so the frontend can start without a database."""
    return {
        "fields": [_demo_field()],
        "rotation_names": {rid: r["label"] for rid, r in ROTATIONS.items()},
        "scenarios": _cfg.config.scenarios,
        "priorities": {"water": 0.20, "nitrogen": 0.15, "resilience": 0.25,
                       "soil": 0.20, "economy": 0.20},
        # Cached real data if already fetched, otherwise the flagged fallback.
        # The frontend loads the live values from /api/nasa.
        "nasa": _nasa_cache["data"] or dict(_NASA_FALLBACK),
    }
