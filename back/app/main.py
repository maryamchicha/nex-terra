"""NEX TERRA FastAPI application."""

from __future__ import annotations

import json
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import config
from . import routes as api
from .simulator import simulator as sim

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("nex-terra")

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
FRONT_DIST = BASE_DIR.parent / "front" / "dist"

DEFAULT_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "https://maryamchicha.github.io",  # GitHub Pages (origin has no path)
]


def _allowed_origins() -> list[str]:
    """Default origins + optional comma-separated CORS_ORIGINS env variable."""
    extra = [o.strip() for o in os.getenv("CORS_ORIGINS", "").split(",") if o.strip()]
    return DEFAULT_ORIGINS + extra


def create_app() -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        # ---- startup ----
        log.info("NEX TERRA starting")
        log.info("data dir: %s", DATA_DIR)
        app.state.field_config = {}
        app.state.scenarios = []
        try:
            with open(DATA_DIR / "config.json", encoding="utf-8") as f:
                cfg = json.load(f)
            app.state.field_config = cfg.get("field", {})
            app.state.scenarios = cfg.get(
                "scenarios", app.state.field_config.get("scenarios", [])
            )
        except FileNotFoundError:
            log.warning("config.json not found in %s", DATA_DIR)
        except json.JSONDecodeError as e:
            log.warning("config.json unreadable: %s", e)
        yield
        # ---- shutdown ----
        log.info("NEX TERRA shutting down")

    app = FastAPI(
        title="NEX TERRA — Rotation Resilience Engine",
        description=(
            "Agricultural decision-support for Moroccan farmers. "
            "Simulates crop rotations against satellite-derived soil + climate "
            "data and ranks alternatives."
        ),
        version="0.1.0",
        docs_url="/docs",
        redoc_url="/redoc",
        lifespan=lifespan,
    )

    app.state.config = config
    app.state.rotator = sim.Rotator()
    app.state.rotator.fit()  # scikit-learn fallback model (baseline)

    # CORS: Vite dev server + GitHub Pages (+ CORS_ORIGINS env variable)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_allowed_origins(),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # ---- routes ------------------------------------------------------------ #
    app.include_router(api.router, prefix="/api")

    # ---- global exception handler ----------------------------------------- #
    @app.exception_handler(StarletteHTTPException)
    async def _http_exception_handler(request: Request, exc: StarletteHTTPException):
        return JSONResponse(
            status_code=exc.status_code,
            content={"detail": exc.detail, "code": exc.status_code},
        )

    # ---- health ------------------------------------------------------------ #
    @app.get("/health")
    def health() -> dict:
        return {"status": "ok", "service": "nex-terra", "engine": "rotation-simulator"}

    # ---- static frontend (only if front/dist was built) -------------------- #
    if (FRONT_DIST / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=FRONT_DIST / "assets"), name="assets")

    @app.get("/", include_in_schema=False)
    def index():
        index_file = FRONT_DIST / "index.html"
        if index_file.is_file():
            return FileResponse(index_file)
        public_index = BASE_DIR / "public" / "index.html"
        if public_index.is_file():
            return FileResponse(public_index)
        return JSONResponse(
            {"service": "nex-terra", "docs": "/docs", "health": "/health"}
        )

    return app


app = create_app()

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host=os.getenv("HOST", "127.0.0.1"),
        port=int(os.getenv("PORT", "8000")),
        reload=True,
    )
