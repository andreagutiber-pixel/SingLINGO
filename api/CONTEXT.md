# api/ — Endpoints REST y WebSocket

## ¿Qué hay aquí?

Este módulo expone el backend Python como una API REST (y WebSocket) que consume
el frontend JavaScript. Todos los endpoints están documentados automáticamente
en http://localhost:8000/api/docs (Swagger UI de FastAPI).

## Endpoints disponibles

### Biblioteca de señas
- `GET /api/signs`
  Retorna todas las señas de todos los países.
  Query params: `country` (asl|lsc|bsl), `category` (alphabet|words|phrases)

- `GET /api/signs/{country}/{sign_id}`
  Retorna datos completos de una seña específica.

### Predicción / IA
- `POST /api/predict`
  Cuerpo: `{landmarks: [{x,y,z} × 21], country: "asl"}`
  Retorna: `{sign_id, confidence, fingers_up, tips, correct}`

- `WebSocket /api/ws/predict`
  Envía landmarks en tiempo real y recibe predicciones continuamente.
  Protocolo: mismo JSON que POST /api/predict

### Progreso del usuario
- `GET /api/progress`
  Retorna las estadísticas del usuario actual (stored en SQLite local).

- `POST /api/progress`
  Cuerpo: `{sign_id, country, success, response_time_ms}`
  Guarda el resultado de un intento.

- `GET /api/progress/summary`
  Retorna resumen: total intentos, precisión por seña, racha actual.

### Sistema
- `GET /api/health`
  Retorna estado del servidor y del modelo ML.

## Schemas (ver models.py)

```python
LandmarkPoint     # {x: float, y: float, z: float}
PredictRequest    # {landmarks: List[LandmarkPoint], country: str}
PredictResponse   # {sign_id, confidence, fingers_up, tips, is_correct, score}
ProgressEntry     # {sign_id, country, success, response_time_ms}
SignData          # Schema completo de una seña
```

## Agregar un nuevo endpoint

1. Definir el schema en `models.py` usando Pydantic
2. Agregar la ruta en `routes.py` usando el router `api_router`
3. La documentación se actualiza automáticamente en /api/docs
