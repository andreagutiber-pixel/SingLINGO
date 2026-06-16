"""
routes.py — Todos los endpoints REST y WebSocket de la API.

Rutas:
  GET  /api/health
  GET  /api/signs
  GET  /api/signs/all
  GET  /api/signs/{country}/{sign_id}
  POST /api/predict              ← SVM (landmarks MediaPipe)
  POST /api/predict-cnn          ← CNN TF (imagen 100×100 base64)  NEW
  WS   /api/ws/predict
  GET  /api/progress/summary
  POST /api/progress
  POST /api/train/collect
  GET  /api/train/status
  POST /api/train/retrain
  POST /api/train/reload
"""
from __future__ import annotations

import json
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import zipfile
from collections import defaultdict, deque
from pathlib import Path
from typing import Dict, List, Optional

import joblib
import numpy as np
from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect, Query, BackgroundTasks, Request
from fastapi.responses import FileResponse, JSONResponse

from api.models import (
    PredictRequest, PredictResponse,
    SignData, SignsResponse,
    ProgressEntry, ProgressSummary, SignProgress,
    HealthResponse,
    CollectRequest, CollectResponse,
    TrainStatusResponse, SignSampleCount, RetrainResponse,
    DatasetQualityResponse, DatasetSignQuality,
    CreateSignRequest, CreateSignResponse,
    CNNPredictRequest, CNNPredictResponse, CNNTopK,
)
from core.classifier import get_classifier, SUPPORTED_COUNTRIES, _load_signs, reload_all
from core.cnn_classifier import get_cnn_classifier
from core.motion_classifier import MotionClassifier, TwoPhaseMotionClassifier, DYNAMIC_SIGNS
from core.sequence_features import FEATURE_SIZE as SEQUENCE_FEATURE_SIZE, extract_sequence_features

api_router = APIRouter()

DB_PATH        = Path(__file__).parent.parent / "data" / "progress.db"
COLLECTED_DIR  = Path(__file__).parent.parent / "data" / "collected"
SCRIPTS_DIR    = Path(__file__).parent.parent / "scripts"
SIGNS_DIR      = Path(__file__).parent.parent / "data" / "signs"
TRAINING_DIR   = Path(__file__).parent.parent / "data" / "training"
MODELS_DIR     = Path(__file__).parent.parent / "data" / "models"


# ── Body-zone helper (MediaPipe Pose) ─────────────────────────────────────────

def _compute_body_zone(pose_lms: list, hand_wrist: dict | None) -> str:
    """
    Calcula en qué zona del cuerpo está la muñeca de la mano dominante.

    Usa coordenadas screen (0–1) de PoseLandmarker (33 puntos).
    Índices relevantes:
      0  = nariz
      11 = hombro izquierdo
      12 = hombro derecho
      23 = cadera izquierda
      24 = cadera derecha

    Zonas: "face" | "chin" | "chest" | "belly" | "other"
    """
    if not pose_lms or len(pose_lms) < 25:
        return "unknown"

    try:
        nose       = pose_lms[0]
        sh_l, sh_r = pose_lms[11], pose_lms[12]
        hip_l, hip_r = pose_lms[23], pose_lms[24]

        # Referencia Y en pantalla (Y crece hacia abajo)
        nose_y       = nose["y"]
        shoulder_y   = (sh_l["y"] + sh_r["y"]) / 2.0
        hip_y        = (hip_l["y"] + hip_r["y"]) / 2.0
        chest_y      = (shoulder_y + hip_y) / 2.0

        # Muñeca: usar el punto 15/16 de pose si no hay hand_wrist
        if hand_wrist:
            wy = hand_wrist.get("y", 0.5)
        else:
            wy = (pose_lms[15]["y"] + pose_lms[16]["y"]) / 2.0

        # Clasificar zona por posición Y
        if wy < nose_y + 0.02:
            return "face"          # sobre la nariz o muy cerca
        elif wy < shoulder_y:
            return "chin"          # entre nariz y hombros
        elif wy < chest_y:
            return "chest"         # entre hombros y cintura
        elif wy < hip_y:
            return "belly"         # entre cintura y cadera
        else:
            return "other"
    except (IndexError, KeyError, TypeError):
        return "unknown"

MIN_SAMPLES    = 30    # mínimo de frames reales para considerar una seña "lista"
COLLECTED_DIR.mkdir(parents=True, exist_ok=True)
_sequence_model_cache: dict[str, tuple[float, dict]] = {}


def _get_sequence_model(country: str) -> Optional[dict]:
    path = MODELS_DIR / f"sequence_{country}.pkl"
    if not path.exists():
        _sequence_model_cache.pop(country, None)
        return None

    mtime = path.stat().st_mtime
    cached = _sequence_model_cache.get(country)
    if cached and cached[0] == mtime:
        return cached[1]

    try:
        data = joblib.load(path)
        if data.get("feature_size") != SEQUENCE_FEATURE_SIZE:
            return None
        _sequence_model_cache[country] = (mtime, data)
        return data
    except Exception:
        _sequence_model_cache.pop(country, None)
        return None


def _predict_sequence(country: str, frames: list[dict]) -> Optional[dict]:
    model_data = _get_sequence_model(country)
    if not model_data or len(frames) < 12:
        return None

    try:
        features = extract_sequence_features(frames).reshape(1, -1)
        pipeline = model_data["pipeline"]
        sign_id = str(pipeline.predict(features)[0])
        confidence = 0.0
        if hasattr(pipeline, "predict_proba"):
            classes = list(pipeline.classes_)
            proba = pipeline.predict_proba(features)[0]
            if sign_id in classes:
                confidence = float(proba[classes.index(sign_id)])
        return {"sign_id": sign_id, "confidence": confidence}
    except Exception:
        return None


def _scan_collection_metadata(jsonl_file: Path) -> tuple[set[str], set[str]]:
    participants: set[str] = set()
    environments: set[str] = set()
    if not jsonl_file.exists():
        return participants, environments

    try:
        with open(jsonl_file, encoding="utf-8") as f:
            for line in f:
                if not line.strip():
                    continue
                try:
                    entry = json.loads(line)
                except Exception:
                    continue
                meta = entry.get("metadata") or {}
                participant_id = meta.get("participant_id")
                environment = meta.get("capture_environment")
                if participant_id:
                    participants.add(str(participant_id))
                if environment:
                    environments.add(str(environment))
    except Exception:
        pass

    return participants, environments


def _scan_sign_quality(jsonl_file: Path, sign: dict) -> DatasetSignQuality:
    participants: set[str] = set()
    environments: set[str] = set()
    count = 0
    two_hand_frames = 0
    pose_frames = 0
    sequence_frames = 0
    bad_rows = 0

    if jsonl_file.exists():
        try:
            with open(jsonl_file, encoding="utf-8") as f:
                for line in f:
                    if not line.strip():
                        continue
                    try:
                        entry = json.loads(line)
                    except Exception:
                        bad_rows += 1
                        continue
                    count += 1
                    meta = entry.get("metadata") or {}
                    if meta.get("participant_id"):
                        participants.add(str(meta.get("participant_id")))
                    if meta.get("capture_environment"):
                        environments.add(str(meta.get("capture_environment")))
                    if entry.get("landmarks_left"):
                        two_hand_frames += 1
                    if entry.get("pose_landmarks"):
                        pose_frames += 1
                    if meta.get("sequence_id") or entry.get("frame_index") is not None:
                        sequence_frames += 1
        except Exception:
            bad_rows += 1

    warnings: list[str] = []
    requires_motion = bool(sign.get("requires_motion"))
    two_handed = bool(sign.get("two_handed"))
    body_zone = sign.get("body_zone")
    requires_body = bool(body_zone and body_zone != "anywhere")

    if bad_rows:
        warnings.append(f"{bad_rows} filas corruptas o ilegibles")
    if count < MIN_SAMPLES:
        warnings.append(f"faltan muestras: {count}/{MIN_SAMPLES}")
    if len(participants) < 5:
        warnings.append(f"pocas personas: {len(participants)}/5 prototipo")
    if len(environments) < 2:
        warnings.append(f"pocos entornos: {len(environments)}/2")
    if two_handed and two_hand_frames < max(MIN_SAMPLES, int(count * 0.80)):
        warnings.append("seña bimanual con pocos frames de segunda mano")
    if requires_motion and sequence_frames < max(MIN_SAMPLES, int(count * 0.80)):
        warnings.append("seña dinámica sin secuencia temporal suficiente")
    if requires_body and pose_frames < max(MIN_SAMPLES, int(count * 0.80)):
        warnings.append("seña corporal sin pose suficiente")

    return DatasetSignQuality(
        sign_id=sign.get("id", ""),
        name=sign.get("name", sign.get("id", "")),
        count=count,
        participants=len(participants),
        environments=len(environments),
        two_hand_frames=two_hand_frames,
        pose_frames=pose_frames,
        sequence_frames=sequence_frames,
        requires_motion=requires_motion,
        two_handed=two_handed,
        body_zone=body_zone,
        ready_static=count >= MIN_SAMPLES and len(participants) >= 1,
        ready_motion=(not requires_motion) or sequence_frames >= MIN_SAMPLES,
        ready_body=(not requires_body) or pose_frames >= MIN_SAMPLES,
        warnings=warnings,
    )


# ── Base de datos de progreso ─────────────────────────────────────────────────

def _init_db():
    con = sqlite3.connect(DB_PATH)
    con.execute("""
        CREATE TABLE IF NOT EXISTS attempts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sign_id TEXT NOT NULL,
            country TEXT NOT NULL,
            success INTEGER NOT NULL,
            response_time_ms INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    """)
    con.commit()
    con.close()


_init_db()


def _signs_to_models(signs_raw: List[dict], country: str) -> List[SignData]:
    result = []
    for s in signs_raw:
        try:
            result.append(SignData(
                id=s["id"],
                name=s["name"],
                emoji=s.get("emoji", "🤟"),
                category=s.get("category", "general"),
                difficulty=s.get("difficulty", 1),
                description=s.get("description", ""),
                tips=s.get("tips", []),
                finger_states=s.get("finger_states", [False] * 5),
                feature_template=s.get("feature_template"),
                country=country,
                two_handed=s.get("two_handed", False),
                body_zone=s.get("body_zone"),
                requires_pose=s.get("requires_pose", False),
                requires_motion=s.get("requires_motion", False),
                motion_type=s.get("motion_type"),
                requires_orientation=s.get("requires_orientation", False),
            ))
        except Exception:
            pass
    return result


# ── Estado global de entrenamiento ───────────────────────────────────────────

_train_lock = threading.Lock()
_train_status: Dict[str, str] = {}  # country → "idle" | "running" | "done" | "error:<msg>"


# ── Health ────────────────────────────────────────────────────────────────────

@api_router.get("/health", response_model=HealthResponse)
async def health():
    model_loaded: Dict[str, bool] = {}
    total = 0
    for c in SUPPORTED_COUNTRIES:
        clf = get_classifier(c)
        model_loaded[c] = clf.is_trained()
        total += len(clf.signs)
    return HealthResponse(
        status="ok",
        model_loaded=model_loaded,
        supported_countries=SUPPORTED_COUNTRIES,
        total_signs=total,
    )


# ── Señas ─────────────────────────────────────────────────────────────────────

@api_router.get("/signs", response_model=SignsResponse)
async def get_signs(
    country: str = Query(default="lsc"),
    category: Optional[str] = Query(default=None),
):
    if country not in SUPPORTED_COUNTRIES:
        raise HTTPException(400, f"País debe ser uno de {SUPPORTED_COUNTRIES}")
    signs_raw = _load_signs(country)
    if category:
        signs_raw = [s for s in signs_raw if s.get("category") == category]
    signs = _signs_to_models(signs_raw, country)
    return SignsResponse(country=country, total=len(signs), signs=signs)


@api_router.get("/signs/all")
async def get_all_signs():
    result = {}
    for c in SUPPORTED_COUNTRIES:
        signs_raw = _load_signs(c)
        result[c] = _signs_to_models(signs_raw, c)
    return {c: [s.model_dump() for s in signs] for c, signs in result.items()}


@api_router.get("/signs/{country}/{sign_id}", response_model=SignData)
async def get_sign(country: str, sign_id: str):
    if country not in SUPPORTED_COUNTRIES:
        raise HTTPException(400, f"País debe ser uno de {SUPPORTED_COUNTRIES}")
    signs_raw = _load_signs(country)
    for s in signs_raw:
        if s["id"] == sign_id:
            return _signs_to_models([s], country)[0]
    raise HTTPException(404, f"Seña '{sign_id}' no encontrada en '{country}'")


# ── Predicción REST ───────────────────────────────────────────────────────────

@api_router.post("/train/signs", response_model=CreateSignResponse)
async def create_training_sign(req: CreateSignRequest):
    """Agrega una seña al catálogo y la deja disponible para recolectar muestras."""
    if req.country not in SUPPORTED_COUNTRIES:
        raise HTTPException(400, f"País debe ser uno de {SUPPORTED_COUNTRIES}")

    sign_id = req.sign_id.strip().upper().replace(" ", "_")
    if not re.fullmatch(r"[A-Z0-9_ÑÁÉÍÓÚÜ-]+", sign_id):
        raise HTTPException(400, "El ID solo puede contener letras, números, guion y guion bajo.")

    category = req.category.strip().lower() or "words"
    allowed_categories = {"alphabet", "words", "greetings", "basic", "nouns", "feelings", "general"}
    if category not in allowed_categories:
        raise HTTPException(400, "Categoría no válida.")

    signs_path = SIGNS_DIR / f"{req.country}.json"
    if not signs_path.exists():
        raise HTTPException(404, f"No existe el catálogo para {req.country.upper()}.")

    with open(signs_path, encoding="utf-8") as f:
        catalog = json.load(f)

    signs = catalog.setdefault("signs", [])
    if any(str(sign.get("id", "")).upper() == sign_id for sign in signs):
        raise HTTPException(409, f"La seña '{sign_id}' ya existe.")

    sign_raw = {
        "id": sign_id,
        "name": req.name.strip(),
        "emoji": "🤟",
        "category": category,
        "difficulty": req.difficulty,
        "two_handed": req.two_handed,
        "description": req.description.strip(),
        "tips": [tip.strip() for tip in req.tips if tip.strip()],
        "finger_states": req.finger_states,
        "finger_states_other": [False] * 5,
        "requires_motion": req.requires_motion,
        "motion_type": req.motion_type if req.requires_motion else None,
        "body_zone": req.body_zone or None,
        "requires_pose": bool(req.body_zone and req.body_zone != "anywhere"),
    }
    signs.append(sign_raw)

    temp_path = signs_path.with_suffix(".json.tmp")
    with open(temp_path, "w", encoding="utf-8") as f:
        json.dump(catalog, f, ensure_ascii=False, indent=2)
        f.write("\n")
    temp_path.replace(signs_path)

    label_map_path = TRAINING_DIR / f"label_map_{req.country}.json"
    label_map = {}
    if label_map_path.exists():
        with open(label_map_path, encoding="utf-8") as f:
            label_map = json.load(f)
    next_idx = max((int(k) for k in label_map), default=-1) + 1
    label_map[str(next_idx)] = sign_id
    with open(label_map_path, "w", encoding="utf-8") as f:
        json.dump(label_map, f, ensure_ascii=False, indent=2)
        f.write("\n")

    reload_all()
    sign_model = _signs_to_models([sign_raw], req.country)[0]
    return CreateSignResponse(
        success=True,
        country=req.country,
        sign=sign_model,
        message=f"Seña '{sign_id}' agregada. Ya puedes capturar sus muestras.",
    )


def _lm_to_raw(pts) -> list:
    """Convierte lista de LandmarkPoint a lista de dicts {x, y, z}."""
    return [{"x": p.x, "y": p.y, "z": p.z} for p in pts]


def _resolve_landmarks(req: PredictRequest):
    """
    Resuelve qué landmarks usar para cada mano.
    Prioridad: landmarks_right > landmarks (legacy) > None.
    No usamos world_landmarks en inferencia para mantener consistencia
    con los datos de entrenamiento (que son screen landmarks).
    """
    # Mano derecha: landmarks_right > landmarks (legacy) > None
    if req.world_landmarks_right:
        right_raw = _lm_to_raw(req.world_landmarks_right)
    elif req.landmarks_right:
        right_raw = _lm_to_raw(req.landmarks_right)
    elif req.landmarks and not req.landmarks_left and not req.world_landmarks_left:
        right_raw = _lm_to_raw(req.landmarks)
    else:
        right_raw = None

    # Mano izquierda: landmarks_left > None
    if req.world_landmarks_left:
        left_raw = _lm_to_raw(req.world_landmarks_left)
    elif req.landmarks_left:
        left_raw = _lm_to_raw(req.landmarks_left)
    else:
        left_raw = None

    if right_raw is None and left_raw is None:
        raise HTTPException(422, "Se requiere al menos una mano con 21 landmarks")

    return right_raw, left_raw


@api_router.post("/predict", response_model=PredictResponse)
async def predict(req: PredictRequest):
    if req.country not in SUPPORTED_COUNTRIES:
        raise HTTPException(400, f"País debe ser uno de {SUPPORTED_COUNTRIES}")

    clf = get_classifier(req.country)
    if not clf.is_trained():
        raise HTTPException(503, "Modelo no entrenado. Ejecuta: python scripts/train_model.py")

    right_raw, left_raw = _resolve_landmarks(req)
    result = clf.predict_from_raw_two_hands(right_raw, left_raw)
    pose_lms = [
        p.model_dump() if hasattr(p, "model_dump") else p.dict()
        for p in req.pose_landmarks
    ] if req.pose_landmarks else None
    body_zone = "unknown"
    if pose_lms and len(pose_lms) >= 25:
        hand_wrist = right_raw[0] if right_raw else (left_raw[0] if left_raw else None)
        body_zone = _compute_body_zone(pose_lms, hand_wrist)

    is_correct: Optional[bool] = None
    if req.target_sign_id:
        is_correct = result["sign_id"] == req.target_sign_id and result["confidence"] >= 0.35
        target_meta = clf.sign_map.get(req.target_sign_id, {})
        required_zone = target_meta.get("body_zone")
        if is_correct and required_zone and required_zone != "anywhere" and body_zone not in (required_zone, "unknown"):
            is_correct = False

    return PredictResponse(
        sign_id=result["sign_id"],
        sign_name=result["sign_name"],
        confidence=result["confidence"],
        fingers_up=result["fingers_up"],
        fingers_up_left=result.get("fingers_up_left"),
        flexion_pcts=result.get("flexion_pcts", [0.0] * 5),
        flexion_pcts_left=result.get("flexion_pcts_left"),
        tips=result["tips"],
        is_correct=is_correct,
        score=result["score"],
        two_handed=result.get("two_handed", False),
        hands_detected=result.get("hands_detected", 1),
        body_zone=body_zone,
    )


@api_router.get("/signs/{country}/templates/all")
async def get_templates(country: str):
    if country not in SUPPORTED_COUNTRIES:
        raise HTTPException(400, f"País debe ser uno de {SUPPORTED_COUNTRIES}")
    clf = get_classifier(country)
    return clf.get_sign_templates()


# ── WebSocket — Predicción en tiempo real con suavizado temporal ──────────────

@api_router.websocket("/ws/predict")
async def ws_predict(websocket: WebSocket):
    """
    WebSocket para predicción en tiempo real con soporte de dos manos y señas de movimiento.

    Protocolo (cliente envía):
      {
        "landmarks":       [...21...],          ← mano dominante (legacy/required)
        "landmarks_right": [...21...] | null,   ← mano derecha (opcional, toma precedencia)
        "landmarks_left":  [...21...] | null,   ← mano izquierda (opcional)
        "country":         "lsc",
        "target_sign_id":  "A"
      }
    Servidor responde: PredictResponse enriquecido con two_handed, hands_detected
                       y motion_trail para visualización de trayectoria.
    """
    await websocket.accept()
    last_target: Dict[str, Optional[str]] = {}
    # TwoPhaseMotionClassifier: primero fija posición, luego detecta movimiento
    two_phase_clf = TwoPhaseMotionClassifier()
    sequence_buffers = defaultdict(lambda: deque(maxlen=40))

    try:
        while True:
            data = await websocket.receive_json()

            # Heartbeat — cliente envía {"type":"ping"} cada 20s para mantener viva la conexión
            if data.get("type") == "ping":
                await websocket.send_json({"type": "pong"})
                continue

            country = data.get("country", "lsc")
            target  = data.get("target_sign_id")
            lms     = data.get("landmarks", [])
            lms_r   = data.get("landmarks_right")
            lms_l   = data.get("landmarks_left")
            world_r = data.get("world_landmarks_right")
            world_l = data.get("world_landmarks_left")
            pose_lms = data.get("pose_landmarks")  # 33 puntos de cuerpo (PoseLandmarker)

            # Usar screen landmarks (consistencia con datos de entrenamiento)
            # Prioridad: landmarks_right > landmarks (legacy)
            left_raw = world_l if (world_l and len(world_l) == 21) else (
                lms_l if (lms_l and len(lms_l) == 21) else None
            )
            right_raw = world_r if (world_r and len(world_r) == 21) else (
                lms_r if (lms_r and len(lms_r) == 21)
                else (lms if len(lms) == 21 and left_raw is None else None)
            )

            if right_raw is None and left_raw is None:
                await websocket.send_json({"error": "Se necesitan 21 landmarks por mano"})
                continue

            clf = get_classifier(country)
            if not clf.is_trained():
                await websocket.send_json({"error": "Modelo no entrenado"})
                continue

            prev_target = last_target.get(country)
            if target != prev_target:
                clf.reset_smoother()
                two_phase_clf.set_target(target)
                sequence_buffers.clear()
                last_target[country] = target

            # ── Predicción MLP estática ───────────────────────────────────────
            result = clf.predict_from_raw_two_hands(right_raw, left_raw, smooth=True)
            sequence_result = None

            sign_meta = clf.sign_map.get(target or "", {})
            needs_sequence = bool(
                target and (
                    target in DYNAMIC_SIGNS
                    or sign_meta.get("requires_motion")
                    or sign_meta.get("requires_pose")
                    or sign_meta.get("body_zone")
                )
            )
            if needs_sequence:
                buffer_key = f"{country}:{target}"
                frame = {
                    "landmarks": right_raw or left_raw,
                    "frame_index": len(sequence_buffers[buffer_key]),
                }
                if left_raw:
                    frame["landmarks_left"] = left_raw
                if pose_lms:
                    frame["pose_landmarks"] = pose_lms
                sequence_buffers[buffer_key].append(frame)

                sequence_result = _predict_sequence(country, list(sequence_buffers[buffer_key]))
                if sequence_result and sequence_result["sign_id"] == target and sequence_result["confidence"] >= 0.55:
                    sign_data = clf.sign_map.get(target, {})
                    confidence = max(result.get("confidence", 0.0), sequence_result["confidence"])
                    result = {
                        **result,
                        "sign_id": target,
                        "sign_name": sign_data.get("name", target),
                        "confidence": confidence,
                        "score": round(confidence * 100, 1),
                        "tips": sign_data.get("tips", [])[:2],
                    }

            # ── Sistema de dos fases (solo para señas dinámicas) ─────────────
            dominant_raw = right_raw or left_raw
            fingers_up   = result.get("fingers_up", [])

            motion_sign_id  = None
            motion_trail    = []
            motion_phase     = "static"
            motion_phase_progress = 1.0

            if target in DYNAMIC_SIGNS:
                motion_phase, motion_phase_progress = two_phase_clf.push_frame(
                    dominant_raw, fingers_up
                )

                if motion_phase == "motion":
                    m_sign, m_conf = two_phase_clf.detect(fingers_up)
                    TIP_IDX_MAP = {
                        "J": 20, "Z": 8, "S": 0,
                        "Ñ": 12, "Ã‘": 12, "Ãƒâ€˜": 12,
                        "G": 8, "H": 12,
                    }
                    if m_sign:
                        motion_sign_id = m_sign
                        tip_idx = TIP_IDX_MAP.get(m_sign, 20)
                        motion_trail = two_phase_clf.get_trail_points(tip_idx)

                        if m_conf > 0.55:
                            sign_data = clf.sign_map.get(m_sign, {})
                            result = {
                                **result,
                                "sign_id":    m_sign,
                                "sign_name":  sign_data.get("name", m_sign),
                                "confidence": m_conf,
                                "score":      round(m_conf * 100, 1),
                                "tips":       sign_data.get("tips", [])[:2],
                            }
                    else:
                        # En fase motion, mostrar trail aunque aún no haya detección
                        tip_idx = TIP_IDX_MAP.get(target, 20)
                        motion_trail = two_phase_clf.get_trail_points(tip_idx)

            # ── Body-zone desde PoseLandmarker (señas de palabras) ──────────────
            body_zone = "unknown"
            if pose_lms and len(pose_lms) >= 25:
                hand_wrist = right_raw[0] if right_raw else (left_raw[0] if left_raw else None)
                body_zone  = _compute_body_zone(pose_lms, hand_wrist)

            is_correct = None
            if target:
                id_match  = result["sign_id"] == target
                conf_ok   = result["confidence"] >= 0.35
                is_correct = id_match and conf_ok

                # Para señas de palabras con zona corporal requerida,
                # la zona debe coincidir (o desconocerse por falta de pose)
                if is_correct and clf.sign_map.get(target, {}).get("body_zone"):
                    required_zone = clf.sign_map[target]["body_zone"]
                    zone_ok = (body_zone == required_zone or
                               body_zone in ("unknown",) or
                               required_zone == "anywhere")
                    if not zone_ok:
                        is_correct = False

            await websocket.send_json({
                **result,
                "is_correct":           is_correct,
                "motion_sign":          motion_sign_id,
                "motion_trail":         motion_trail,
                "motion_phase":         motion_phase,
                "motion_phase_progress": motion_phase_progress,
                "body_zone":            body_zone,
                "sequence_sign":        sequence_result["sign_id"] if sequence_result else None,
                "sequence_confidence":  sequence_result["confidence"] if sequence_result else 0.0,
            })

    except WebSocketDisconnect:
        pass


# ── Progreso ──────────────────────────────────────────────────────────────────

@api_router.post("/progress")
async def save_progress(entry: ProgressEntry):
    con = sqlite3.connect(DB_PATH)
    con.execute(
        "INSERT INTO attempts (sign_id, country, success, response_time_ms) VALUES (?,?,?,?)",
        (entry.sign_id, entry.country, int(entry.success), entry.response_time_ms),
    )
    con.commit()
    con.close()
    return {"ok": True}


@api_router.get("/progress/summary", response_model=ProgressSummary)
async def progress_summary():
    con = sqlite3.connect(DB_PATH)
    rows = con.execute(
        "SELECT sign_id, country, success, response_time_ms FROM attempts ORDER BY created_at"
    ).fetchall()
    con.close()

    if not rows:
        return ProgressSummary(
            total_attempts=0, total_successes=0, overall_accuracy=0.0,
            current_streak=0, best_streak=0, signs_mastered=0,
            by_sign=[], by_country={},
        )

    by_sign: Dict[str, dict] = {}
    by_country: Dict[str, int] = {}
    total_attempts = len(rows)
    total_successes = 0
    streak = 0
    best_streak = 0

    for sign_id, country, success, rt in rows:
        key = f"{country}:{sign_id}"
        if key not in by_sign:
            all_signs = _load_signs(country)
            sign_name = next((s["name"] for s in all_signs if s["id"] == sign_id), sign_id)
            by_sign[key] = {"sign_id": sign_id, "sign_name": sign_name, "attempts": 0,
                            "successes": 0, "best_time": None}
        by_sign[key]["attempts"] += 1
        if success:
            by_sign[key]["successes"] += 1
            total_successes += 1
            streak += 1
            best_streak = max(best_streak, streak)
        else:
            streak = 0
        if rt and (by_sign[key]["best_time"] is None or rt < by_sign[key]["best_time"]):
            by_sign[key]["best_time"] = rt
        by_country[country] = by_country.get(country, 0) + 1

    sign_progress = []
    signs_mastered = 0
    for data in by_sign.values():
        acc = data["successes"] / data["attempts"] if data["attempts"] > 0 else 0
        mastered = acc >= 0.8 and data["attempts"] >= 5
        if mastered:
            signs_mastered += 1
        sign_progress.append(SignProgress(
            sign_id=data["sign_id"],
            sign_name=data["sign_name"],
            attempts=data["attempts"],
            successes=data["successes"],
            accuracy=round(acc, 3),
            best_time_ms=data["best_time"],
            mastered=mastered,
        ))

    overall_acc = total_successes / total_attempts if total_attempts > 0 else 0
    return ProgressSummary(
        total_attempts=total_attempts,
        total_successes=total_successes,
        overall_accuracy=round(overall_acc, 3),
        current_streak=streak,
        best_streak=best_streak,
        signs_mastered=signs_mastered,
        by_sign=sign_progress,
        by_country=by_country,
    )


# ── Recolección de datos de entrenamiento ─────────────────────────────────────

@api_router.post("/train/collect", response_model=CollectResponse)
async def collect_samples(req: CollectRequest):
    """
    Guarda frames de landmarks reales para una seña.
    Los datos se almacenan en data/collected/{country}/{sign_id}.jsonl
    (una línea JSON por frame).
    """
    if req.country not in SUPPORTED_COUNTRIES:
        raise HTTPException(400, f"País debe ser uno de {SUPPORTED_COUNTRIES}")

    out_dir = COLLECTED_DIR / req.country
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / f"{req.sign_id}.jsonl"
    metadata = {
        "participant_id": req.participant_id,
        "dominant_hand": req.dominant_hand,
        "capture_environment": req.capture_environment,
        "camera_distance": req.camera_distance,
        "sequence_id": req.sequence_id,
        "capture_mode": req.capture_mode,
    }

    saved = 0
    with open(out_file, "a", encoding="utf-8") as f:
        for sample in req.samples:
            lm_list = [{"x": p.x, "y": p.y, "z": p.z} for p in sample.landmarks]
            entry: dict = {"landmarks": lm_list, "metadata": metadata}
            # Guardar world landmarks 3D cuando estén disponibles (para features v6)
            if sample.world_landmarks:
                entry["world_landmarks"] = [{"x": p.x, "y": p.y, "z": p.z}
                                             for p in sample.world_landmarks]
            if sample.landmarks_left:
                entry["landmarks_left"] = [{"x": p.x, "y": p.y, "z": p.z}
                                            for p in sample.landmarks_left]
            if sample.world_landmarks_left:
                entry["world_landmarks_left"] = [{"x": p.x, "y": p.y, "z": p.z}
                                                  for p in sample.world_landmarks_left]
            if sample.pose_landmarks:
                entry["pose_landmarks"] = [
                    {"x": p.x, "y": p.y, "z": p.z, "visibility": p.visibility}
                    for p in sample.pose_landmarks
                ]
            if sample.frame_index is not None:
                entry["frame_index"] = sample.frame_index
            if sample.timestamp_ms is not None:
                entry["timestamp_ms"] = sample.timestamp_ms
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
            saved += 1

    # Contar total de muestras para esta seña
    total = 0
    try:
        with open(out_file, encoding="utf-8") as f:
            total = sum(1 for line in f if line.strip())
    except Exception:
        total = saved

    return CollectResponse(
        sign_id=req.sign_id,
        country=req.country,
        saved=saved,
        total_for_sign=total,
        message=f"✅ {saved} frames guardados. Total para '{req.sign_id}': {total}",
    )


@api_router.get("/train/status/{country}", response_model=TrainStatusResponse)
async def train_status(country: str):
    """
    Retorna cuántas muestras reales hay por seña para un país.
    """
    if country not in SUPPORTED_COUNTRIES:
        raise HTTPException(400, f"País debe ser uno de {SUPPORTED_COUNTRIES}")

    signs_raw = _load_signs(country)
    country_dir = COLLECTED_DIR / country
    country_dir.mkdir(parents=True, exist_ok=True)

    signs_data = []
    signs_ready = 0
    signs_with_data = 0

    for sign in signs_raw:
        sid = sign["id"]
        jsonl_file = country_dir / f"{sid}.jsonl"
        count = 0
        if jsonl_file.exists():
            try:
                with open(jsonl_file, encoding="utf-8") as f:
                    count = sum(1 for line in f if line.strip())
            except Exception:
                count = 0
        participants, environments = _scan_collection_metadata(jsonl_file)

        enough = count >= MIN_SAMPLES
        if count > 0:
            signs_with_data += 1
        if enough:
            signs_ready += 1

        signs_data.append(SignSampleCount(
            sign_id=sid,
            count=count,
            enough=enough,
            participants=len(participants),
            environments=len(environments),
            name=sign.get("name", sid),
            category=sign.get("category", "general"),
            two_handed=sign.get("two_handed", False),
            requires_motion=sign.get("requires_motion", False),
            body_zone=sign.get("body_zone"),
            requires_pose=sign.get("requires_pose", False),
        ))

    return TrainStatusResponse(
        country=country,
        total_signs=len(signs_raw),
        signs_with_data=signs_with_data,
        signs_ready=signs_ready,
        ready_to_train=signs_ready >= max(1, len(signs_raw) // 3),
        samples_per_sign=signs_data,
        min_samples_needed=MIN_SAMPLES,
    )


@api_router.get("/train/quality/{country}", response_model=DatasetQualityResponse)
async def train_quality(country: str):
    """Reporte de calidad del dataset antes de reentrenar."""
    if country not in SUPPORTED_COUNTRIES:
        raise HTTPException(400, f"País debe ser uno de {SUPPORTED_COUNTRIES}")

    signs_raw = _load_signs(country)
    country_dir = COLLECTED_DIR / country
    country_dir.mkdir(parents=True, exist_ok=True)

    sign_reports = [
        _scan_sign_quality(country_dir / f"{sign['id']}.jsonl", sign)
        for sign in signs_raw
    ]
    total_frames = sum(item.count for item in sign_reports)
    ready_count = sum(1 for item in sign_reports if item.ready_static and item.ready_motion and item.ready_body)

    issues: list[str] = []
    missing = [item.sign_id for item in sign_reports if item.count == 0]
    if missing:
        issues.append(f"Sin muestras: {', '.join(missing[:12])}" + ("..." if len(missing) > 12 else ""))
    weak_people = [item.sign_id for item in sign_reports if item.count > 0 and item.participants < 5]
    if weak_people:
        issues.append(f"Faltan personas en {len(weak_people)} señas; objetivo mínimo 5 por prototipo.")
    dynamic_weak = [item.sign_id for item in sign_reports if item.requires_motion and item.sequence_frames < MIN_SAMPLES]
    if dynamic_weak:
        issues.append(f"Faltan secuencias temporales en dinámicas: {', '.join(dynamic_weak)}")
    body_weak = [item.sign_id for item in sign_reports if item.body_zone not in (None, 'anywhere') and item.pose_frames < MIN_SAMPLES]
    if body_weak:
        issues.append(f"Faltan landmarks de cuerpo en: {', '.join(body_weak)}")

    return DatasetQualityResponse(
        country=country,
        total_signs=len(signs_raw),
        total_frames=total_frames,
        ready_to_train=ready_count >= max(1, len(signs_raw) // 3),
        issues=issues,
        signs=sign_reports,
    )


@api_router.post("/train/retrain/{country}", response_model=RetrainResponse)
async def retrain(country: str, background_tasks: BackgroundTasks):
    """
    Dispara el pipeline completo de reentrenamiento en background:
      1. augment_data.py  (si hay datos reales)
      2. train_model.py   (entrena con todos los datos disponibles)
      3. recarga los modelos en memoria
    Retorna inmediatamente; usa GET /api/train/retrain-status/{country} para monitorear.
    """
    if country not in SUPPORTED_COUNTRIES:
        raise HTTPException(400, f"País debe ser uno de {SUPPORTED_COUNTRIES}")

    with _train_lock:
        if _train_status.get(country) == "running":
            return RetrainResponse(
                success=False, country=country,
                message="Ya hay un entrenamiento en progreso para este país.",
            )
        _train_status[country] = "running"

    background_tasks.add_task(_run_retrain, country)

    return RetrainResponse(
        success=True, country=country,
        message=f"⏳ Entrenamiento iniciado para {country.upper()}. "
                f"Espera ~30-60 segundos. Monitorea en /api/train/retrain-status/{country}",
    )


@api_router.get("/train/retrain-status/{country}")
async def retrain_status(country: str):
    """Estado del último entrenamiento disparado para este país."""
    status = _train_status.get(country, "idle")
    return {"country": country, "status": status}


@api_router.post("/train/reload")
async def reload_models():
    """Recarga todos los modelos en memoria (sin reentrenar)."""
    reload_all()
    return {"ok": True, "message": "Modelos recargados en memoria."}


@api_router.post("/predict-cnn", response_model=CNNPredictResponse)
async def predict_cnn(req: CNNPredictRequest):
    """
    Clasifica una imagen de mano usando el modelo CNN de TensorFlow (LESHO).

    El cliente envía una imagen 100×100 en escala de grises codificada en base64.
    El modelo CNN devuelve la letra más probable del alfabeto LESHO (A-Z sin J, Ñ, Z).

    Flujo frontend:
      1. MediaPipe detecta la mano → bounding box desde landmarks
      2. JS recorta y escala la imagen del video a 100×100 en escala de grises
      3. Codifica como base64 PNG → POST /api/predict-cnn
      4. Muestra letra + confianza
    """
    import base64
    import io
    import numpy as np

    cnn = get_cnn_classifier()

    if not cnn.is_loaded():
        # Intentar carga lazy (primera llamada)
        cnn.load()
        if not cnn.is_loaded():
            return CNNPredictResponse(
                letter="?", confidence=0.0,
                top3=[], model_ready=False,
            )

    try:
        # Decodificar base64 → imagen
        img_bytes = base64.b64decode(req.image_b64)

        # Convertir a numpy array grayscale 100×100
        try:
            from PIL import Image
            img = Image.open(io.BytesIO(img_bytes)).convert("L").resize((100, 100))
            img_array = np.array(img, dtype=np.float32) / 255.0
        except ImportError:
            # Fallback sin PIL: asumir que ya vino como raw bytes de una imagen
            import struct
            img_array = np.frombuffer(img_bytes, dtype=np.uint8).astype(np.float32)
            if img_array.size == 100 * 100:
                img_array = img_array.reshape(100, 100) / 255.0
            else:
                raise ValueError(f"No se pudo decodificar imagen (size={img_array.size}), instala Pillow")

        letter, confidence = cnn.predict(img_array)
        top3 = [CNNTopK(letter=l, confidence=c) for l, c in cnn.predict_topk(img_array, k=3)]

        return CNNPredictResponse(
            letter=letter,
            confidence=round(confidence, 4),
            top3=top3,
            model_ready=True,
        )

    except Exception as e:
        raise HTTPException(500, f"Error procesando imagen CNN: {str(e)}")


@api_router.get("/cnn/status")
async def cnn_status():
    """Estado del modelo CNN (cargado, error, clases)."""
    from core.cnn_classifier import LESHO_CLASSES
    cnn = get_cnn_classifier()
    if not cnn.is_loaded():
        cnn.load()
    return {
        "loaded": cnn.is_loaded(),
        "error": cnn._error,
        "num_classes": len(LESHO_CLASSES),
        "alphabet": LESHO_CLASSES,
        "model": "TensorFlow SavedModel (LESHO Sign Language)",
        "repo": "https://github.com/Inteligencia-Artificial-2022/Sign_languaje_model-test",
    }


@api_router.get("/train/export/{country}")
async def export_training_dataset(country: str):
    """Exporta las muestras recolectadas y metadatos de entrenamiento en un ZIP."""
    if country not in SUPPORTED_COUNTRIES:
        raise HTTPException(400, f"PaÃ­s debe ser uno de {SUPPORTED_COUNTRIES}")

    export_path = Path(tempfile.gettempdir()) / f"signlingo_{country}_dataset.zip"
    collected_dir = COLLECTED_DIR / country
    signs_path = SIGNS_DIR / f"{country}.json"
    label_map_path = TRAINING_DIR / f"label_map_{country}.json"

    with zipfile.ZipFile(export_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        manifest = {
            "country": country,
            "format": "signlingo-dataset-v1",
            "collected_files": [],
            "notes": "Importar desde Entrenamiento > Importar dataset. No borra muestras existentes.",
        }
        if collected_dir.exists():
            for fp in sorted(collected_dir.glob("*.jsonl")):
                arc = f"collected/{country}/{fp.name}"
                zf.write(fp, arc)
                manifest["collected_files"].append(arc)
        if signs_path.exists():
            zf.write(signs_path, f"signs/{country}.json")
        if label_map_path.exists():
            zf.write(label_map_path, f"training/label_map_{country}.json")
        zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))

    return FileResponse(
        export_path,
        filename=f"signlingo_{country}_dataset.zip",
        media_type="application/zip",
    )


@api_router.post("/train/import/{country}")
async def import_training_dataset(country: str, request: Request):
    """Importa un ZIP exportado por SignLingo y mezcla muestras JSONL por seÃ±a."""
    if country not in SUPPORTED_COUNTRIES:
        raise HTTPException(400, f"PaÃ­s debe ser uno de {SUPPORTED_COUNTRIES}")

    tmp_dir = Path(tempfile.mkdtemp(prefix=f"signlingo_import_{country}_"))
    zip_path = tmp_dir / "dataset.zip"
    try:
        body = await request.body()
        if not body:
            raise HTTPException(400, "Sube un archivo .zip exportado desde SignLingo.")
        with open(zip_path, "wb") as f:
            f.write(body)

        imported_files = 0
        imported_lines = 0
        target_dir = COLLECTED_DIR / country
        target_dir.mkdir(parents=True, exist_ok=True)

        with zipfile.ZipFile(zip_path) as zf:
            for info in zf.infolist():
                name = info.filename.replace("\\", "/")
                prefix = f"collected/{country}/"
                if not name.startswith(prefix) or not name.endswith(".jsonl"):
                    continue

                sign_id = Path(name).stem
                if not sign_id.replace("_", "").replace("-", "").isalnum():
                    continue

                raw = zf.read(info).decode("utf-8", errors="ignore")
                lines = [line for line in raw.splitlines() if line.strip()]
                if not lines:
                    continue

                out_path = target_dir / f"{sign_id.upper()}.jsonl"
                with open(out_path, "a", encoding="utf-8") as out:
                    for line in lines:
                        try:
                            json.loads(line)
                        except Exception:
                            continue
                        out.write(line + "\n")
                        imported_lines += 1
                imported_files += 1

        return {
            "ok": True,
            "country": country,
            "files": imported_files,
            "frames": imported_lines,
            "message": f"Importadas {imported_lines} muestras desde {imported_files} archivos.",
        }
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


@api_router.delete("/train/collected/{country}/{sign_id}")
async def delete_collected(country: str, sign_id: str):
    """Borra los datos recolectados para una seña (para empezar de nuevo)."""
    if country not in SUPPORTED_COUNTRIES:
        raise HTTPException(400, f"País debe ser uno de {SUPPORTED_COUNTRIES}")
    path = COLLECTED_DIR / country / f"{sign_id}.jsonl"
    if path.exists():
        path.unlink()
        return {"ok": True, "message": f"Datos de '{sign_id}' borrados."}
    return {"ok": False, "message": f"No había datos para '{sign_id}'."}


# ── Background task: pipeline de reentrenamiento ──────────────────────────────

def _run_retrain(country: str):
    """
    Corre el pipeline completo de reentrenamiento en un thread separado:
      augment_data.py → train_model.py → reload_all()
    """
    python = sys.executable
    root = SCRIPTS_DIR.parent

    try:
        # Paso 1: Aumentación (solo si hay datos reales)
        country_collected = COLLECTED_DIR / country
        has_real_data = country_collected.exists() and any(country_collected.glob("*.jsonl"))

        if has_real_data:
            result = subprocess.run(
                [python, str(SCRIPTS_DIR / "augment_data.py"), country],
                cwd=str(root), capture_output=True, text=True, timeout=120,
            )
            if result.returncode != 0:
                _train_status[country] = f"error:augment falló: {result.stderr[:200]}"
                return

        # Paso 2: Entrenamiento
        result = subprocess.run(
            [python, str(SCRIPTS_DIR / "train_model.py"), country],
            cwd=str(root), capture_output=True, text=True, timeout=300,
        )
        if result.returncode != 0:
            _train_status[country] = f"error:train falló: {result.stderr[:200]}"
            return

        seq_result = subprocess.run(
            [python, str(SCRIPTS_DIR / "train_sequence_model.py"), country],
            cwd=str(root), capture_output=True, text=True, timeout=180,
        )
        if seq_result.returncode != 0:
            print(f"[train_sequence_model] aviso: {seq_result.stderr[:300]}")

        # Paso 3: Recargar modelos en memoria
        reload_all()
        _train_status[country] = "done"

    except subprocess.TimeoutExpired:
        _train_status[country] = "error:timeout"
    except Exception as e:
        _train_status[country] = f"error:{str(e)[:200]}"
