# SignLingo — Plataforma de Aprendizaje de Lengua de Señas con IA

## ¿Qué es este proyecto?

SignLingo es una aplicación Python que enseña lengua de señas usando la cámara del
computador, inteligencia artificial y una interfaz visual inmersiva con efectos holográficos.

## Estado actual (Semana 1/4)

- [x] Estructura del proyecto completa
- [x] Backend FastAPI con rutas REST y WebSocket
- [x] Clasificador de señas basado en SVM (scikit-learn)
- [x] Extracción de features desde landmarks MediaPipe
- [x] Biblioteca de señas: ASL (36), LSC Colombia (15), BSL UK (15)
- [x] Frontend: landing page + modo aprender + modo práctica + progreso
- [x] Detección de mano en tiempo real en el browser (MediaPipe Tasks Vision)
- [x] Overlay holográfico (mano fantasma) en modo práctica
- [ ] Reentrenamiento con datos reales (pendiente — ver FUTURE_WORK)
- [ ] Base de datos de usuarios persistente (pendiente)
- [ ] Más señas y países (pendiente)

## Cómo correr el proyecto

```bash
cd sign-language-app

# Instalar dependencias (solo la primera vez)
pip install -r requirements.txt

# Generar datos sintéticos y entrenar el modelo
python scripts/generate_data.py
python scripts/train_model.py

# Correr el servidor
python main.py
# Abre http://localhost:8000
```

## Arquitectura

```
Browser (JS)                    Python (FastAPI)
─────────────────────           ─────────────────────────────
Camera Feed                     main.py  ← entry point
    ↓                               ↓
MediaPipe Tasks Vision          api/routes.py  ← REST + WebSocket
(detecta 21 landmarks)              ↓
    ↓                           core/classifier.py  ← SVM predict
Send landmarks JSON  ──────►    core/landmarks.py   ← features
                                    ↓
Receive prediction   ◄──────    data/signs/*.json   ← library
    ↓
Draw overlay + feedback
```

## Stack tecnológico

| Capa | Tecnología | Por qué |
|------|-----------|---------|
| API | FastAPI + Uvicorn | Async, tipado, auto-docs en /api/docs |
| ML | scikit-learn SVM | Rápido, interpretable, mejorable con más datos |
| Features | NumPy | Vectorización de landmarks MediaPipe |
| Frontend | HTML/CSS/JS puro | Sin build step, fácil de modificar |
| Detección | MediaPipe Tasks Vision (CDN) | Runs in browser, 30 FPS, 21 landmarks por mano |
| Persistencia | SQLite (aiosqlite) | Progreso del usuario, sin servidor externo |

## Estructura de carpetas

```
sign-language-app/
├── CONTEXT.md          ← Este archivo (leer primero)
├── requirements.txt    ← Dependencias Python
├── main.py             ← Entry point FastAPI
├── api/
│   ├── CONTEXT.md      ← Cómo funcionan las rutas
│   ├── routes.py       ← Todos los endpoints
│   └── models.py       ← Pydantic schemas (request/response)
├── core/
│   ├── CONTEXT.md      ← Cómo funciona el ML
│   ├── landmarks.py    ← Extracción de features (normalización)
│   └── classifier.py   ← Clasificador SVM + templates
├── data/
│   ├── CONTEXT.md      ← Formato de los datos de señas
│   ├── signs/
│   │   ├── asl.json    ← American Sign Language (26 letras + palabras)
│   │   ├── lsc.json    ← Lengua de Señas Colombiana
│   │   └── bsl.json    ← British Sign Language
│   └── models/         ← Modelos entrenados (.pkl) - generados al entrenar
├── frontend/
│   ├── CONTEXT.md      ← Cómo funciona el frontend
│   ├── index.html      ← Landing page
│   ├── app.html        ← Aplicación principal
│   ├── css/style.css   ← Estilos (dark/neon theme)
│   └── js/
│       ├── mediapipe-handler.js  ← Detección de manos en browser
│       ├── api-client.js         ← Llamadas al backend Python
│       ├── overlay.js            ← Mano holográfica / overlay
│       ├── practice.js           ← Lógica del modo práctica
│       ├── learn.js              ← Modo aprender (biblioteca)
│       └── app.js                ← Controlador principal
└── scripts/
    ├── CONTEXT.md          ← Cómo generar datos y entrenar
    ├── generate_data.py    ← Genera datos sintéticos para entrenamiento
    └── train_model.py      ← Entrena el modelo SVM y lo guarda
```

## FUTURE_WORK — Para continuar el proyecto

### Semana 2: Mejorar el modelo
1. Recolectar datos reales: usar `scripts/collect_data.py` (por crear) para
   grabar landmarks reales de cada seña con múltiples usuarios
2. Reentrenar con datos reales: `python scripts/train_model.py --data=real`
3. Agregar señas dinámicas (gestos con movimiento) usando LSTM

### Semana 3: Más funcionalidades
1. Sistema de lecciones progresivas (nivel 1, 2, 3)
2. Modo quiz (adivina la seña)
3. Más países: ASL-Brazil (Libras), JSL (Japonesa)
4. Modo competencia (comparar con amigos)

### Semana 4: Pulido y deploy
1. Base de datos PostgreSQL para múltiples usuarios
2. Autenticación simple
3. Deploy en servidor (Docker + nginx)
4. Grabación de sesiones de práctica

## Notas importantes

- El modelo se entrena con datos SINTÉTICOS para la demo. La precisión mejorará
  significativamente cuando se agreguen datos reales de personas.
- MediaPipe corre 100% en el browser (WebAssembly), no se envía video al servidor,
  solo los 21 puntos de la mano (muy poco dato, muy privado).
- Los archivos .pkl del modelo se generan al ejecutar train_model.py y se guardan
  en data/models/. No están en git, hay que generarlos en cada instalación.
