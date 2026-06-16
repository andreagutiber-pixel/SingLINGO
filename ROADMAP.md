# SignLingo — Roadmap de Implementaciones Futuras

> **Proyecto:** SignLingo — Aprendizaje de Lengua de Señas con IA  
> **Universidad:** Universidad de La Guajira  
> **Estado actual:** Alfabeto LSC (91.3%), ASL (72.3%), BSL (42.3%) con MLPClassifier v6 + features 3D invariantes a rotación

---

## Índice

1. [Fase 1 — Señas corporales y palabras simples](#fase-1)
2. [Fase 2 — Modo de entrenamiento manual de palabras](#fase-2)
3. [Fase 3 — Modelo temporal (LSTM/GRU) para señas dinámicas](#fase-3)
4. [Fase 4 — Quiz avanzado y gamificación](#fase-4)
5. [Fase 5 — App móvil](#fase-5)
6. [Resumen de archivos a modificar](#archivos)

---

<a name="fase-1"></a>
## Fase 1 — Señas corporales y palabras simples

### El problema
El sistema actual solo detecta la forma de la mano (21 landmarks de MediaPipe HandLandmarker). Para señas como:

- **Gracias** (LSC): tocar la barbilla y bajar la mano
- **Por favor** (LSC): mano en el pecho con movimiento circular
- **Hola** (LSC): mano abierta cerca de la cabeza con movimiento
- **Sí / No** (LSC): movimientos de cabeza o mano en zonas específicas del cuerpo

...no basta con saber la forma de la mano; hay que saber **dónde está la mano en relación con el cuerpo**.

### Solución: MediaPipe PoseLandmarker

MediaPipe tiene un modelo separado de pose corporal que detecta 33 landmarks del cuerpo completo (hombros, codos, muñecas, cadera, rodillas, cara).

#### Landmarks clave para señas LSC

| Índice | Punto | Uso en señas |
|--------|-------|-------------|
| 0 | Nariz | Señas cerca de la cara |
| 7, 8 | Oídos izq/der | Señas en cabeza |
| 9, 10 | Boca izq/der | Señas en boca/barbilla |
| 11, 12 | Hombros izq/der | Escala del cuerpo, señas en pecho |
| 13, 14 | Codos izq/der | Señas de brazos |

#### Cambios requeridos en el código

**1. `frontend/js/mediapipe-handler.js`**
```javascript
// Agregar al constructor:
this.poseDetector = null;

// En init(), cargar modelo de pose adicional:
const poseModel = await PoseLandmarker.createFromOptions(vision, {
  baseOptions: {
    modelAssetPath: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task",
    delegate: "GPU"
  },
  runningMode: "VIDEO",
  numPoses: 1,
});
this.poseDetector = poseModel;

// En _detectLoop(), correr pose en paralelo con manos:
const poseResults = this.poseDetector.detectForVideo(video, timestamp);
const poseWorldLandmarks = poseResults.worldLandmarks?.[0] ?? null;

// Incluir en el evento handsUpdate:
document.dispatchEvent(new CustomEvent("handsUpdate", {
  detail: {
    right, left, total_hands,
    pose: poseWorldLandmarks,  // <-- NUEVO
  }
}));
```

**2. `core/landmarks.py`** — Agregar función `extract_body_features()`
```python
# Nuevas features basadas en posición relativa mano-cuerpo
# ~20 features adicionales por seña

def extract_body_features(hand_world_lm, pose_world_lm) -> np.ndarray:
    """
    Calcula features de posición relativa de la mano al cuerpo.
    Requiere landmarks de pose (33 puntos) + landmarks de mano (21 puntos).
    
    Features calculadas (20 total):
    - Distancia mano→nariz (normalizada por ancho de hombros)
    - Distancia mano→barbilla  
    - Distancia mano→hombro derecho
    - Distancia mano→hombro izquierdo
    - Distancia mano→pecho (midpoint hombros)
    - Si la mano está arriba/abajo de los hombros (binario)
    - Si la mano está arriba/abajo de la nariz (binario)
    - Ángulo mano→nariz en el plano XY
    - Ángulo mano→pecho en el plano XY
    - Vector 3D mano→nariz (3 valores)
    - Vector 3D mano→pecho (3 valores)
    - Velocidad angular de la mano (requiere buffer temporal)
    """
    NOSE       = 0
    L_SHOULDER = 11
    R_SHOULDER = 12
    
    wrist = np.array([hand_world_lm[0]['x'], hand_world_lm[0]['y'], hand_world_lm[0]['z']])
    nose  = np.array([pose_world_lm[NOSE]['x'], pose_world_lm[NOSE]['y'], pose_world_lm[NOSE]['z']])
    l_sh  = np.array([pose_world_lm[L_SHOULDER]['x'], ...])
    r_sh  = np.array([pose_world_lm[R_SHOULDER]['x'], ...])
    
    shoulder_width = np.linalg.norm(l_sh - r_sh) + 1e-6  # escala del cuerpo
    chest_center   = (l_sh + r_sh) / 2
    
    features = [
        np.linalg.norm(wrist - nose)        / shoulder_width,
        np.linalg.norm(wrist - chest_center) / shoulder_width,
        (wrist[1] - nose[1])    / shoulder_width,  # relativo altura nariz
        (wrist[1] - l_sh[1])    / shoulder_width,  # relativo altura hombros
        *(wrist - nose)          / shoulder_width,  # vector 3D x,y,z
        *(wrist - chest_center)  / shoulder_width,  # vector 3D x,y,z
        # ... más features según se necesite
    ]
    return np.array(features, dtype=np.float32)
```

**3. `api/models.py`** — Ampliar `PredictRequest`
```python
class PredictRequest(BaseModel):
    # ... campos actuales ...
    pose_landmarks: Optional[List[Dict]] = None  # 33 puntos de MediaPipe Pose
```

**4. `api/routes.py`** — Usar pose en predicción
```python
@router.post("/predict")
async def predict(req: PredictRequest):
    # ... extracción de features actual ...
    
    if req.pose_landmarks and features_hand is not None:
        body_feats = extract_body_features(hand_landmarks, req.pose_landmarks)
        features   = np.concatenate([features_hand, body_feats])
    
    # El modelo debe haber sido reentrenado con estas features ampliadas
```

**5. `scripts/generate_data.py`** — Generar datos sintéticos de cuerpo

Para palabras como "gracias" (mano en barbilla), simular:
```python
# Posición base de nariz/hombros en espacio 3D
FACE_ZONE   = {"y_offset": -0.3, "radius": 0.1}  # 30cm arriba de hombros
CHEST_ZONE  = {"y_offset":  0.1, "radius": 0.15}
CHIN_ZONE   = {"y_offset": -0.2, "radius": 0.05}
```

**6. `data/signs/lsc.json`** — Agregar nuevas señas
```json
{
  "id": "GRACIAS",
  "name": "Gracias",
  "category": "words",
  "description": "Mano abierta tocando la barbilla, luego se baja hacia adelante",
  "finger_states": [true, true, true, true, true],
  "requires_pose": true,
  "motion_type": "chin_to_forward"
}
```

**Tamaño del nuevo feature vector:**
- Actual: 96 features (48/mano × 2)
- Con cuerpo: 96 + 20 = **116 features** para señas con referencia corporal
- Con pose bilateral (ambas manos + cuerpo): 96 + 20 + 20 = **136 features**

---

<a name="fase-2"></a>
## Fase 2 — Modo de entrenamiento manual de palabras

### Objetivo
Permitir que el usuario (o administrador) grabe secuencias completas para **palabras y expresiones** (no solo letras del alfabeto), que luego aparezcan en el modo práctica.

### Arquitectura propuesta

Las palabras son señas **temporales**: no un frame estático, sino una secuencia de 30-60 frames que captura el movimiento completo.

#### Nuevo archivo: `data/collected/lsc/words/GRACIAS.jsonl`
```json
// Cada línea = una muestra = secuencia de frames
{"frames": [...], "pose_frames": [...], "duration_ms": 1800, "word": "GRACIAS"}
{"frames": [...], "pose_frames": [...], "duration_ms": 2100, "word": "GRACIAS"}
```

#### Cambios en el backend

**`api/routes.py`** — Nuevo endpoint
```python
@router.post("/train/collect-word")
async def collect_word(req: WordCollectRequest):
    """
    Guarda una secuencia completa de frames para una palabra/expresión.
    A diferencia de /collect (que guarda frames individuales),
    este endpoint guarda secuencias temporales completas.
    """

@router.get("/train/words/{country}")
async def get_word_list(country: str):
    """Lista de palabras disponibles y sus muestras grabadas."""
```

**`api/models.py`** — Nuevo modelo
```python
class WordCollectRequest(BaseModel):
    word_id:   str
    country:   str
    sequences: List[List[Dict]]  # lista de secuencias, cada una = lista de frames
    pose_sequences: Optional[List[List[Dict]]] = None  # secuencias de pose
```

#### Cambios en el frontend

**`frontend/js/collect.js`** — Modo de captura de secuencias
```javascript
// Nuevo modo: grabar secuencia completa (para palabras)
// - Botón "Iniciar" → graba hasta que se presione "Detener" o se detecte pausa
// - Muestra countdown de 3 segundos antes de empezar
// - Guarda la secuencia completa como una unidad
// - Necesita mínimo 10 secuencias por palabra para entrenar
```

**`frontend/app.html`** — Nueva sub-sección en el modo entrenar
```html
<!-- Tab selector dentro de #section-train -->
<div class="train-tabs">
  <button class="train-tab active" data-tab="alphabet">Alfabeto</button>
  <button class="train-tab" data-tab="words">Palabras / Expresiones</button>
</div>
```

---

<a name="fase-3"></a>
## Fase 3 — Modelo temporal (LSTM/GRU) para señas dinámicas

### Por qué el MLP actual no es suficiente para palabras

El MLPClassifier actual clasifica **un frame** a la vez. Para el alfabeto eso está bien (cada letra es estática). Pero para palabras como "gracias" o "hola", la seña **es el movimiento completo**, no una posición.

### Solución: LSTM o GRU

Una red recurrente procesa una **secuencia de frames** y reconoce el patrón temporal completo.

#### Nuevo archivo: `core/temporal_classifier.py`

```python
import torch
import torch.nn as nn
import numpy as np
from typing import List, Optional, Tuple
from collections import deque

SEQUENCE_LENGTH = 30   # frames por secuencia (~1 segundo a 30 FPS)
FEATURE_SIZE    = 116  # features con pose corporal (96 hand + 20 body)
HIDDEN_SIZE     = 128
NUM_LAYERS      = 2
NUM_CLASSES     = 50   # palabras + expresiones a reconocer

class SignLSTM(nn.Module):
    """
    Red LSTM para reconocimiento de señas dinámicas (palabras/expresiones).
    Procesa secuencias de SEQUENCE_LENGTH frames con FEATURE_SIZE features cada uno.
    """
    def __init__(self, input_size=FEATURE_SIZE, hidden_size=HIDDEN_SIZE,
                 num_layers=NUM_LAYERS, num_classes=NUM_CLASSES, dropout=0.3):
        super().__init__()
        self.lstm = nn.LSTM(
            input_size=input_size,
            hidden_size=hidden_size,
            num_layers=num_layers,
            batch_first=True,
            dropout=dropout,
        )
        self.classifier = nn.Sequential(
            nn.Linear(hidden_size, 64),
            nn.ReLU(),
            nn.Dropout(0.3),
            nn.Linear(64, num_classes),
        )
    
    def forward(self, x):
        # x: (batch, seq_len, features)
        out, _ = self.lstm(x)
        last_hidden = out[:, -1, :]   # último frame
        return self.classifier(last_hidden)


class TemporalPredictor:
    """
    Predictor en tiempo real usando buffer deslizante de frames.
    Se usa en el WebSocket de predicción para palabras.
    """
    def __init__(self, model_path: str, label_encoder_path: str):
        self.buffer = deque(maxlen=SEQUENCE_LENGTH)
        self.model  = self._load(model_path)
        # ... cargar label encoder ...
    
    def push_frame(self, features: np.ndarray):
        """Añadir features de un frame al buffer."""
        self.buffer.append(features)
    
    def predict(self) -> Optional[Tuple[str, float]]:
        """
        Intenta reconocer una seña si hay suficientes frames.
        Returns: (word_id, confidence) o None
        """
        if len(self.buffer) < SEQUENCE_LENGTH:
            return None
        
        seq = np.array(self.buffer, dtype=np.float32)  # (30, 116)
        seq_tensor = torch.FloatTensor(seq).unsqueeze(0)  # (1, 30, 116)
        
        with torch.no_grad():
            logits = self.model(seq_tensor)
            probs  = torch.softmax(logits, dim=1)
            conf, idx = probs.max(dim=1)
        
        label = self.label_encoder.classes_[idx.item()]
        return label, float(conf.item())
```

#### Nuevo script: `scripts/train_temporal_model.py`

```python
"""
Entrena el modelo LSTM con las secuencias grabadas en data/collected/*/words/.

Proceso:
1. Cargar secuencias de JSONL (frames con landmarks + pose)
2. Extraer features v6 + body features para cada frame
3. Padding/truncating a SEQUENCE_LENGTH frames
4. Aumentar datos: flip horizontal, velocidad ×0.8/×1.2, ruido gaussiano
5. Entrenar con Adam, lr=0.001, scheduler cosine
6. Guardar modelo en data/models/{country}_temporal.pt
"""
```

#### Cambios en `api/routes.py` — WebSocket de predicción

```python
# En el WebSocket /ws/predict, agregar modo dual:
# 1. MLP estático → para letras del alfabeto (frame actual)
# 2. LSTM temporal → para palabras/expresiones (buffer de frames)

# Enviar ambas predicciones al cliente:
response = {
    "alphabet": {
        "sign_id": mlp_prediction.sign_id,
        "confidence": mlp_prediction.confidence,
    },
    "word": {
        "word_id": lstm_prediction.word_id if lstm_prediction else None,
        "confidence": lstm_prediction.confidence if lstm_prediction else 0,
    }
}
```

### Requisitos de datos para LSTM

| Palabras por idioma | Secuencias mínimas por palabra | Total secuencias |
|---------------------|-------------------------------|-----------------|
| 20 palabras comunes | 50 secuencias                 | 1,000 secuencias |
| 50 palabras         | 50 secuencias                 | 2,500 secuencias |

Con aumentación ×10: 10,000 – 25,000 secuencias para entrenar.

---

<a name="fase-4"></a>
## Fase 4 — Quiz avanzado y gamificación

### 4.1 — Modo deletreo mejorado (ya parcialmente implementado)

Mejoras pendientes sobre el modo actual (`frontend/js/spell.js`):

- **Modo multijugador local**: dos usuarios se turnan deletreando palabras (mismo dispositivo)
- **Modo contrarreloj**: palabras por minuto como métrica
- **Leaderboard local**: `api/routes.py` + `data/progress/` para guardar récords
- **Palabras temáticas**: vocabulario de colores, números, familia, animales

### 4.2 — Modo historia / lecciones estructuradas

En lugar de práctica libre, el usuario sigue un currículo progresivo:

```
Lección 1: Vocales (A, E, I, O, U)
Lección 2: Consonantes simples (B, C, D, F, L, M, N, P, R, T)
Lección 3: Señas especiales (G, H, S)
Lección 4: Señas de movimiento (J, Z)
Lección 5: Primera palabra — SOL
Lección 6: Primera frase — BUENOS DÍAS
```

**Archivos a crear:**
- `data/curriculum/lsc_curriculum.json` — definición de lecciones
- `frontend/js/lesson.js` — LessonMode class
- Sección `#section-lessons` en `app.html`

### 4.3 — Sistema de logros / badges

```python
# data/achievements.json
{
  "first_letter": {
    "title": "Primera Seña",
    "description": "Realizaste tu primera seña correctamente",
    "icon": "🌱",
    "condition": "total_correct >= 1"
  },
  "alphabet_master": {
    "title": "Maestro del Alfabeto",
    "description": "Dominaste todas las letras del alfabeto",
    "icon": "🏆",
    "condition": "signs_mastered >= 27"
  },
  "speed_demon": {
    "title": "Velocidad de Rayo",
    "description": "Completaste una palabra de 5 letras en menos de 10 segundos",
    "icon": "⚡",
    "condition": "fastest_word_ms <= 10000 and word_length >= 5"
  }
}
```

---

<a name="fase-5"></a>
## Fase 5 — App móvil

### Enfoque recomendado: React Native + Expo

El backend FastAPI puede servir tanto la web app como la app móvil sin cambios (solo CORS y autenticación).

**Estructura propuesta:**
```
signlingo-mobile/
  app/
    (tabs)/
      index.tsx       # Pantalla principal / biblioteca
      practice.tsx    # Modo práctica (usa cámara del dispositivo)
      spell.tsx       # Modo deletreo
      progress.tsx    # Progreso personal
  components/
    HandOverlay.tsx   # Overlay de landmarks sobre cámara
    SignCard.tsx      # Tarjeta de seña
    SpellLetters.tsx  # Componente de letras del deletreo
  hooks/
    useMediaPipe.ts   # Hook para MediaPipe en React Native (via WebView o tfjs)
    usePredictor.ts   # Hook para conectar al backend WebSocket
```

**Consideraciones:**
- MediaPipe en React Native requiere usar `expo-camera` + TensorFlow Lite o una WebView con el modelo JS
- El backend puede desplegarse en Railway/Render; la app conecta por HTTPS/WSS
- La cámara del teléfono tiene mejor calidad → mejores predicciones

---

<a name="archivos"></a>
## Resumen de archivos a modificar por fase

### Fase 1 (Señas corporales)

| Archivo | Cambio |
|---------|--------|
| `frontend/js/mediapipe-handler.js` | Añadir `PoseLandmarker` en paralelo a `HandLandmarker` |
| `frontend/js/api-client.js` | Incluir `pose_landmarks` en payload de predicción |
| `core/landmarks.py` | Nueva función `extract_body_features()` |
| `core/classifier.py` | Ampliar `FEATURE_SIZE` de 96 a 116 |
| `api/models.py` | Campo `pose_landmarks` en `PredictRequest` |
| `api/routes.py` | Usar pose en `/predict` y `/ws/predict` |
| `scripts/generate_data.py` | Generar datos sintéticos con posición corporal |
| `scripts/train_model.py` | Reentrenar con vector de features ampliado |
| `data/signs/lsc.json` | Agregar señas que requieren pose (`"requires_pose": true`) |

### Fase 2 (Entrenamiento de palabras)

| Archivo | Cambio |
|---------|--------|
| `frontend/js/collect.js` | Modo de captura de secuencias temporales |
| `frontend/app.html` | Tab de "Palabras" dentro de sección entrenar |
| `api/models.py` | `WordCollectRequest` con secuencias |
| `api/routes.py` | Endpoints `/train/collect-word`, `/train/words/{country}` |
| `data/collected/{country}/words/` | Nueva carpeta para secuencias de palabras |

### Fase 3 (Modelo temporal LSTM)

| Archivo | Cambio |
|---------|--------|
| `core/temporal_classifier.py` | Nuevo archivo — `SignLSTM` + `TemporalPredictor` |
| `scripts/train_temporal_model.py` | Nuevo archivo — entrenamiento LSTM |
| `api/routes.py` | WebSocket dual: MLP (letras) + LSTM (palabras) |
| `requirements.txt` | Agregar `torch` o `tensorflow` para LSTM |
| `data/models/{country}_temporal.pt` | Modelos LSTM entrenados |

### Fase 4 (Quiz avanzado)

| Archivo | Cambio |
|---------|--------|
| `frontend/js/spell.js` | Modo contrarreloj, leaderboard, multijugador |
| `frontend/js/lesson.js` | Nuevo — LessonMode con currículo |
| `frontend/app.html` | Sección de lecciones, sistema de logros |
| `data/curriculum/` | Nueva carpeta con definición de lecciones |
| `api/routes.py` | Endpoints de logros, récords, leaderboard |

---

## Prioridad recomendada

```
Corto plazo (antes de la entrega — Fase 0 ya completa ✅)
  ✅ Alfabeto LSC con features 3D invariantes
  ✅ Modo deletreo básico
  ✅ Guías especiales para G, H, J, S, Z
  ✅ Auto-update de contadores al grabar

Mediano plazo (post-entrega, 2-4 semanas)
  → Fase 1: MediaPipe Pose + primeras 10 palabras LSC
  → Fase 2: Modo de grabación de secuencias de palabras

Largo plazo (proyecto de mayor escala)
  → Fase 3: Modelo LSTM para secuencias temporales
  → Fase 4: Gamificación completa
  → Fase 5: App móvil React Native
```

---

*Documento generado automáticamente. Última actualización: Junio 2026.*
