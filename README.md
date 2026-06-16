# SignLingo — Aprendizaje de Lengua de Señas con IA en Tiempo Real

**Proyecto Final — Universidad de La Guajira**  
Programa de Ingeniería de Sistemas — Inteligencia Artificial  
Entrega: 16 de junio de 2026

---

## Descripción

SignLingo es una aplicación web de aprendizaje de lengua de señas que utiliza visión por computadora e inteligencia artificial para detectar y evaluar señas en tiempo real directamente desde la cámara del usuario. La entrega está enfocada en **LSC (Lengua de Señas Colombiana)**.

La aplicación no requiere instalación de software especializado — funciona completamente en el navegador web usando WebAssembly y WebGL.

---

## Características Principales

| Característica | Descripción |
|---|---|
| **Detección en tiempo real** | MediaPipe Tasks Vision (~30 FPS, GPU/WASM) |
| **Invarianza a rotación** | Features v6: ángulos articulares 3D — funciona con la mano en cualquier orientación |
| **Clasificador neuronal** | MLPClassifier (256→128→64) — más preciso que SVM para señas similares |
| **Dos manos** | Soporte simultáneo de mano derecha e izquierda para señas bimanuales |
| **Señas de movimiento** | J y Z detectadas por trayectoria del wrist/índice |
| **Retroalimentación visual** | Porcentaje de flexión por dedo, overlay 3D, hints de postura |
| **Entrenamiento desde la app** | Captura de datos reales → reentrenamiento con un clic |
| **Sin GPU requerida** | Corre en CPU; GPU acelera la detección MediaPipe si está disponible |

---

## Arquitectura del Sistema

```
┌─────────────────────────────────────────────────────────────┐
│                        FRONTEND                              │
│  index.html / app.html (HTML5 + CSS3 + JavaScript ES2022)   │
│                                                              │
│  mediapipe-handler.js  ←── MediaPipe Tasks Vision (WASM)    │
│         │                     Hand Landmarker v0.10.14       │
│         │ worldLandmarks (3D métricos)                       │
│  practice.js / collect.js                                    │
│         │ WebSocket / REST                                    │
└─────────┼────────────────────────────────────────────────────┘
          │
┌─────────▼────────────────────────────────────────────────────┐
│                      BACKEND (FastAPI)                        │
│  main.py → api/routes.py                                     │
│                                                              │
│  POST /api/predict     ← landmarks JSON                      │
│  WS   /api/ws/predict  ← stream tiempo real                  │
│  POST /api/train/collect                                     │
│  POST /api/train/retrain/{country}                           │
└─────────┬────────────────────────────────────────────────────┘
          │
┌─────────▼────────────────────────────────────────────────────┐
│                 MOTOR DE IA  (core/)                          │
│                                                              │
│  landmarks.py                                                │
│    extract_features_v6(pts)  →  48 features/mano             │
│      ├── 15 ángulos articulares 3D (invariantes a rotación)  │
│      ├──  5 porcentajes de flexión                           │
│      ├──  5 ratios de extensión                              │
│      ├──  5 tip-to-wrist (normalizados)                      │
│      ├──  5 distancias entre puntas                          │
│      ├──  4 ángulos de abducción                             │
│      ├──  3 normal de la palma                               │
│      └──  6 features del pulgar + estadísticas               │
│                                                              │
│  classifier.py                                               │
│    MLPClassifier (256,128,64) + StandardScaler               │
│    TemporalSmoother (ventana 3 frames)                        │
│                                                              │
│  motion_classifier.py                                        │
│    Detección de J, Z por trayectoria de puntos               │
└──────────────────────────────────────────────────────────────┘
```

---

## Features v6 — Invarianza a Rotación

El problema central en la clasificación de señas es que la misma seña puede verse diferente si la mano está orientada hacia arriba, de lado, o hacia la cámara. La versión anterior (v5) usaba coordenadas XY absolutas que son sensibles a la rotación.

**Features v6** resuelven esto usando exclusivamente:

1. **Ángulos articulares 3D** (15 features): El ángulo en cada articulación (MCP, PIP, DIP) de los 5 dedos, calculado como el ángulo entre los vectores de los huesos adyacentes en 3D. Estos ángulos son matemáticamente invariantes a cualquier rotación global de la mano.

2. **Porcentajes de flexión** (5 features): `1 - chord/arc` por dedo — qué tan doblado está cada dedo.

3. **Distancias normalizadas** (19 features): ratios de extensión, distancias punta-muñeca, distancias entre puntas — todos normalizados por el tamaño de la palma.

4. **Abducción** (4 features): spread entre dedos adyacentes.

5. **Normal de palma** (3 features): orientación de la palma en 3D.

6. **Pulgar** (2 features): posición relativa del pulgar (clave para distinguir A, B, E, S).

**Total: 48 features por mano = 96 features (dos manos)**

---

## Módulos Principales

### `core/landmarks.py`
Extracción de features desde landmarks MediaPipe.
- `extract_features_v6(pts)` — 48 features rotation-invariant
- `extract_features_two_hands_v6()` — 96 features (dos manos)
- `get_flexion_percentages()` — porcentaje de flexión por dedo
- Backward compatible con features v5 (78 por mano)

### `core/classifier.py`
Clasificador principal con pipeline sklearn.
- MLPClassifier (256→128→64, ReLU, Adam, early stopping)
- `TemporalSmoother` — suavizado de predicciones en ventana de 3 frames
- Detecta automáticamente la versión del modelo (v5/v6)
- Soporta 1 y 2 manos

### `core/motion_classifier.py`
Detección de señas dinámicas (J, Z).
- Buffer circular de landmarks de los últimos N frames
- Extrae trayectoria de tip de meñique (J) o índice (Z)
- Detecta curvatura y dirección del movimiento

### `core/landmarks.py` — Pipeline de features
```
WorldLandmarks 3D  →  normalize_landmarks()  →  extract_features_v6()  →  MLPClassifier
     (MediaPipe)         wrist=origen              48 features/mano          predicción
                         palm_size=1               invariantes a rotación
```

### Datos y modelos
- `data/signs/lsc.json` contiene el catálogo principal de señas LSC.
- `data/models/classifier_lsc.pkl` contiene el modelo entrenado para la demo.
- `data/collected/lsc/` contiene muestras recolectadas para LSC.
- `data/training/` contiene datos de entrenamiento disponibles para el proyecto.

### `api/routes.py`
Endpoints REST y WebSocket.
- `POST /api/predict` — predicción HTTP
- `WS /api/ws/predict` — stream en tiempo real
- `POST /api/train/collect` — recolecta datos reales
- `POST /api/train/retrain/{country}` — reentrena en background

---

## Instalación y Ejecución

### Requisitos
- Python 3.11+
- Cámara web
- Navegador moderno (Chrome, Firefox, Edge)

### Instalación
```bash
pip install -r requirements.txt
```

### Iniciar la aplicación
```bash
python main.py
```
Abre: `http://localhost:5000`

---

## Dependencias

| Paquete | Versión | Uso |
|---|---|---|
| FastAPI | 0.115.5 | Framework web API REST + WebSocket |
| uvicorn | 0.32.1 | Servidor ASGI asíncrono |
| scikit-learn | 1.5.2 | MLPClassifier + StandardScaler |
| numpy | 2.1.3 | Álgebra lineal, cálculo de features |
| joblib | 1.4.2 | Serialización de modelos |
| Pillow | ≥10.0.0 | Procesamiento de imágenes |
| MediaPipe | CDN 0.10.14 | Detección de manos en tiempo real (frontend) |

---

## Estructura del Proyecto

```
signlingo/
├── main.py                    # Punto de entrada FastAPI
├── requirements.txt           # Dependencias Python
├── api/
│   ├── routes.py              # Endpoints REST y WebSocket
│   └── models.py              # Schemas Pydantic
├── core/
│   ├── landmarks.py           # Extracción de features v6 (rotation-invariant)
│   ├── classifier.py          # MLPClassifier + TemporalSmoother
│   ├── motion_classifier.py   # Detección de señas de movimiento (J, Z)
│   └── cnn_classifier.py      # Clasificador CNN (LESHO, opcional)
├── data/
│   ├── signs/                 # Definiciones de señas (JSON)
│   │   └── lsc.json           # Catálogo principal LSC
│   ├── models/                # Modelos entrenados (.pkl)
│   ├── training/              # Datos sintéticos generados (.csv)
│   └── collected/             # Datos reales capturados (.jsonl)
└── frontend/
    ├── index.html             # Landing page
    ├── app.html               # Aplicación principal
    ├── css/                   # Estilos
    └── js/
        ├── mediapipe-handler.js  # Detección MediaPipe + worldLandmarks
        ├── practice.js           # Modo práctica
        ├── collect.js            # Captura de datos reales
        ├── learn.js              # Biblioteca de señas
        ├── overlay.js            # Renderizado del esqueleto de mano
        └── api-client.js         # Cliente HTTP/WebSocket
```

---

## Flujo de Uso

### Modo Práctica
1. Usuario practica señas de LSC
2. La aplicación presenta la seña a practicar
3. MediaPipe detecta la mano en tiempo real (~30 FPS)
4. Los world landmarks 3D se envían al backend vía WebSocket
5. El MLPClassifier compara con los 96 features v6 del modelo
6. La app muestra: seña detectada, porcentaje de confianza, retroalimentación por dedo
7. Al alcanzar ≥60% de confianza durante 3 frames seguidos → seña correcta

### Modo Captura (Entrenamiento)
1. Instructor selecciona una seña del alfabeto
2. Hace la seña frente a la cámara
3. Presiona "Grabar" → 60 frames capturados con world landmarks 3D
4. Los datos se guardan en `data/collected/{country}/{sign_id}.jsonl`
5. Presiona "Reentrenar" → pipeline de augmentación ×30 + MLPClassifier

---

## Decisiones de Diseño

### Por qué MLPClassifier y no LinearSVC
LinearSVC traza hiperplanos lineales en el espacio de features. Para señas similares (A, E, M, N, S difieren principalmente en la posición del pulgar), las fronteras de decisión son no-lineales. El MLP aprende representaciones jerárquicas que capturan estas relaciones complejas.

### Por qué features v6 y no deep learning
1. **Sin GPU**: El MLP con 96 features tiene inference <2ms en CPU. Un CNN requeriría GPU.
2. **Pocos datos**: Con 900 muestras sintéticas por seña, el MLP generaliza mejor que un CNN.
3. **Interpretabilidad**: Los ángulos articulares tienen significado físico — facilita el debugging.
4. **Invarianza garantizada**: Los ángulos 3D son matemáticamente invariantes a rotación.

### Por qué world landmarks y no screen landmarks
MediaPipe provee dos tipos de landmarks:
- **Screen landmarks**: coordenadas normalizadas [0,1] en la imagen 2D
- **World landmarks**: coordenadas en metros en espacio 3D real (relativas al wrist)

Los world landmarks son más precisos para calcular ángulos articulares en 3D, especialmente cuando la mano está girada respecto a la cámara.

---

## Métricas del Modelo

| Idioma | Train Acc | Test Acc | Señas |
|--------|-----------|----------|-------|
| LSC    | ~95%      | ~88%     | 27    |

*Accuracy con datos sintéticos. La precisión mejora significativamente al capturar datos reales desde la app.*

---

## Uso de IA

Durante el desarrollo se usaron herramientas de inteligencia artificial como apoyo para:

- Organizar la arquitectura general del proyecto.
- Mejorar explicaciones y documentación.
- Revisar errores de instalación y ejecución.
- Apoyar la escritura de funciones del backend y del frontend.
- Analizar el documento de requisitos del proyecto final.

Herramientas utilizadas:

- Replit
- Codex

El grupo revisó y adaptó el código generado o sugerido. Cada integrante puede explicar durante la sustentación la parte del proyecto que trabajó y el funcionamiento general de la aplicación.

## Integrantes

- Jose Carlos Barreto Toro
- Maria Jose Cujia Gamez
- Sally Andrea Gutiérrez Bermúdez

## Autores

Proyecto Final — Inteligencia Artificial  
Universidad de La Guajira  
2026
