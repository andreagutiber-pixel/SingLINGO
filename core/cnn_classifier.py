"""
cnn_classifier.py — Clasificador CNN basado en el modelo TF de LESHO.

Repositorio origen:
  https://github.com/Inteligencia-Artificial-2022/Sign_languaje_model-test

Entrada:  imagen 100×100 en escala de grises (float32, valores 0-1)
Salida:   letra del alfabeto LESHO + confianza

Alfabeto LESHO: A-Z excepto J, Ñ y Z = 24 clases estáticas
Orden: A B C D E F G H I K L M N O P Q R S T U V W X Y

NOTA DE COMPATIBILIDAD:
  El modelo fue entrenado con TF2 + Keras 2. En TF 2.16+ (Keras 3),
  la carga con tf.keras o TFSMLayer falla por el error add_slot.
  Usamos tf.compat.v1.Session + saved_model.loader que sí funciona
  con modelos en formato SavedModel v1/v2 legacy.
"""
from __future__ import annotations

import logging
import os
import threading
from pathlib import Path
from typing import Optional, Tuple

import numpy as np

logger = logging.getLogger("signlingo")

CNN_MODEL_DIR = Path(__file__).parent.parent / "data" / "models" / "cnn_model"
LESHO_CLASSES = list("ABCDEFGHIKLMNOPQRSTUVWXY")  # 24 letras
IMG_SIZE = 100

# Mutex para la sesión TF1 (no es thread-safe)
_infer_lock = threading.Lock()


def _softmax(x: np.ndarray) -> np.ndarray:
    e = np.exp(x - x.max())
    return e / e.sum()


def _norm(arr: np.ndarray) -> np.ndarray:
    """Asegura (1, 100, 100, 1) float32."""
    a = np.array(arr, dtype=np.float32)
    if a.ndim == 2:
        a = a[:, :, np.newaxis]
    return a.reshape(1, IMG_SIZE, IMG_SIZE, 1)


class CNNClassifier:
    def __init__(self):
        self._sess        = None   # tf.compat.v1.Session
        self._in_tensor   = None   # nombre del tensor de entrada
        self._out_tensor  = None   # nombre del tensor de salida
        self._loaded      = False
        self._error: Optional[str] = None

    # ── Loading ───────────────────────────────────────────────────────────────

    def load(self) -> bool:
        """
        Carga el modelo usando tf.compat.v1.saved_model.loader.
        Esta API es compatible con SavedModels legacy (TF2 + Keras 2).
        """
        if self._loaded:
            return True
        if self._error:
            return False
        if not CNN_MODEL_DIR.exists():
            self._error = f"Modelo CNN no encontrado en {CNN_MODEL_DIR}"
            logger.warning(self._error)
            return False

        os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
        os.environ.setdefault("TF_ENABLE_ONEDNN_OPTS", "0")

        try:
            import tensorflow as tf

            # Usar grafo propio para no contaminar el grafo global
            graph = tf.Graph()
            with graph.as_default():
                sess = tf.compat.v1.Session(graph=graph)
                meta_graph = tf.compat.v1.saved_model.loader.load(
                    sess,
                    [tf.saved_model.SERVING],
                    str(CNN_MODEL_DIR),
                )

            # Extraer los tensores de entrada/salida de la signature
            sig_key = tf.saved_model.DEFAULT_SERVING_SIGNATURE_DEF_KEY
            if sig_key not in meta_graph.signature_def:
                # Usar la primera disponible
                sig_key = list(meta_graph.signature_def.keys())[0]

            sig_def   = meta_graph.signature_def[sig_key]
            in_info   = list(sig_def.inputs.values())[0]
            out_info  = list(sig_def.outputs.values())[0]

            in_name  = in_info.name
            out_name = out_info.name

            # Verificar dimensiones
            out_shape = [d.size for d in out_info.tensor_shape.dim]
            n_classes = out_shape[-1] if out_shape else "?"
            logger.info(f"  CNN (v1 Session): sig='{sig_key}' in='{in_name}' out='{out_name}' clases={n_classes}")

            # Test inference
            dummy = np.zeros((1, IMG_SIZE, IMG_SIZE, 1), dtype=np.float32)
            with graph.as_default():
                result = sess.run(out_name, feed_dict={in_name: dummy})
            logger.info(f"  CNN: test OK → shape={result.shape}, sum={result.sum():.3f} ✓")

            self._sess       = sess
            self._graph      = graph
            self._in_tensor  = in_name
            self._out_tensor = out_name
            self._loaded     = True
            return True

        except Exception as e:
            self._error = str(e)
            logger.warning(f"  CNN v1 Session failed: {e}")
            return False

    def is_loaded(self) -> bool:
        return self._loaded

    # ── Inference ─────────────────────────────────────────────────────────────

    def _run(self, arr: np.ndarray) -> np.ndarray:
        """Ejecuta inferencia con mutex (sesión TF1 no es thread-safe)."""
        with _infer_lock:
            with self._graph.as_default():
                raw = self._sess.run(
                    self._out_tensor,
                    feed_dict={self._in_tensor: arr},
                )
        return raw[0]  # quitar dimensión batch

    def _class_proba(self, img_array: np.ndarray) -> np.ndarray:
        """
        Devuelve probabilidades renormalizadas sobre las 24 clases LESHO.

        NOTA: El modelo tiene 27455 neuronas de salida (artefacto de
        entrenamiento). Solo las primeras 24 corresponden a las clases
        del alfabeto LESHO entrenadas (verificado: argmax siempre cae
        en rango 0-23 para imágenes reales de manos).
        Renormalizamos con softmax solo sobre esas 24 logits.
        """
        n   = len(LESHO_CLASSES)
        raw = self._run(_norm(img_array)).astype(np.float64)  # shape (27455,)
        return _softmax(raw[:n])

    def predict(self, img_array: np.ndarray) -> Tuple[str, float]:
        """
        Args:
            img_array: (100,100) o (100,100,1) float32 normalizado 0-1
        Returns:
            (letra, confianza)  — confianza renormalizada sobre 24 clases LESHO
        """
        if not self._loaded:
            if not self.load():
                return "?", 0.0
        try:
            proba = self._class_proba(img_array)
            idx   = int(np.argmax(proba))
            return LESHO_CLASSES[idx], float(proba[idx])
        except Exception as e:
            logger.error(f"CNN predict: {e}")
            return "?", 0.0

    def predict_topk(self, img_array: np.ndarray, k: int = 3) -> list:
        if not self._loaded:
            if not self.load():
                return []
        try:
            proba   = self._class_proba(img_array)
            top_idx = np.argsort(proba)[::-1][:k]
            return [(LESHO_CLASSES[i], float(proba[i])) for i in top_idx]
        except Exception as e:
            logger.error(f"CNN topk: {e}")
            return []


_cnn = CNNClassifier()


def get_cnn_classifier() -> CNNClassifier:
    return _cnn
