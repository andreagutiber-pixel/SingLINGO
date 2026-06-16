"""
main.py — Entry point del servidor FastAPI de SignLingo.

Arranca:
  - API REST en /api/*
  - WebSocket en /api/ws/predict
  - Frontend estático en /

Uso:
    python main.py          (desarrollo, con hot-reload)
    python main.py --prod   (producción, sin reload)
"""
from __future__ import annotations

import argparse
import os
import logging
import sys
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from api.routes import api_router

ROOT = Path(__file__).parent

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("signlingo")


def create_app() -> FastAPI:
    app = FastAPI(
        title="SignLingo API",
        description="API para la plataforma de aprendizaje de lengua de señas con IA",
        version="1.0.0",
        docs_url="/api/docs",
        redoc_url="/api/redoc",
        openapi_url="/api/openapi.json",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(api_router, prefix="/api")

    frontend_dir = ROOT / "frontend"
    if frontend_dir.exists():
        app.mount("/static", StaticFiles(directory=str(frontend_dir)), name="static")

        @app.get("/app", include_in_schema=False)
        async def serve_app():
            return FileResponse(frontend_dir / "app.html")

        @app.get("/", include_in_schema=False)
        async def serve_index():
            return FileResponse(frontend_dir / "index.html")

        @app.get("/{path:path}", include_in_schema=False)
        async def serve_frontend(path: str):
            target = frontend_dir / path
            if target.exists() and target.is_file():
                return FileResponse(target)
            return FileResponse(frontend_dir / "index.html")

    @app.on_event("startup")
    async def on_startup():
        import asyncio
        import subprocess as sp

        log.info("🤟  SignLingo server starting...")

        # ── Auto-entrenar si no existen modelos ──────────────────────────────
        from core.classifier import get_classifier, SUPPORTED_COUNTRIES
        needs_train = not any(
            (ROOT / "data" / "models" / f"classifier_{c}.pkl").exists()
            for c in SUPPORTED_COUNTRIES
        )
        if needs_train:
            log.info("⚙️  No se encontraron modelos. Generando datos y entrenando automáticamente…")
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(None, _auto_train)

        for c in SUPPORTED_COUNTRIES:
            clf = get_classifier(c)
            status = "✓ modelo cargado" if clf.is_trained() else "⚠ modelo NO entrenado"
            log.info(f"  {c.upper():5s}: {len(clf.signs)} señas | {status}")

        # Cargar modelo CNN de TensorFlow (LESHO)
        from core.cnn_classifier import get_cnn_classifier
        cnn = get_cnn_classifier()
        cnn.load()
        log.info("📚  Docs API: http://localhost:5000/api/docs")
        log.info("🌐  Frontend: http://localhost:5000")

    return app


def _auto_train():
    """Genera datos sintéticos y entrena los modelos LSC, ASL y BSL."""
    import subprocess as sp
    python = sys.executable
    steps = [
        ([python, "scripts/generate_data.py"],  "Generando datos sintéticos…"),
        ([python, "scripts/train_model.py"],    "Entrenando modelos SVM…"),
    ]
    for cmd, msg in steps:
        log.info(f"  ▶ {msg}")
        result = sp.run(cmd, cwd=str(ROOT), capture_output=True, text=True, timeout=300)
        if result.returncode != 0:
            log.error(f"  ✗ Error: {result.stderr[:300]}")
            return
        log.info(f"  ✓ Listo")


app = create_app()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--prod", action="store_true", help="Production mode (no reload)")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", 5000)))
    args = parser.parse_args()

    models_exist = any(
        (ROOT / "data" / "models" / f"classifier_{c}.pkl").exists()
        for c in ["asl", "lsc", "bsl"]
    )
    if not models_exist:
        log.warning("=" * 60)
        log.warning("  ⚠️  No hay modelos entrenados.")
        log.warning("  Ejecuta primero:")
        log.warning("    python scripts/generate_data.py")
        log.warning("    python scripts/train_model.py")
        log.warning("  El servidor arrancará pero /api/predict dará error 503.")
        log.warning("=" * 60)

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=args.port,
        reload=not args.prod,
        log_level="info",
    )
