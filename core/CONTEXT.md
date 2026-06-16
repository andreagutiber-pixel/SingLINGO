# core/ — Motor de IA y Procesamiento de Landmarks

## ¿Qué hay aquí?

Este módulo contiene toda la lógica de machine learning e inteligencia artificial
del proyecto. Aquí es donde los 21 puntos (landmarks) de la mano se convierten
en una predicción de seña.

## Flujo de datos

```
Browser envía: [{x, y, z} × 21 puntos]
                        ↓
       landmarks.py → normalize_landmarks()
                        ↓
       landmarks.py → extract_features()
       Resultado: vector de 15 números (float64)
                        ↓
       classifier.py → SignClassifier.predict()
       Resultado: {sign_id, confidence, fingers_up}
```

## Archivos

### landmarks.py

Contiene las funciones de normalización y extracción de features:

- `normalize_landmarks(raw)` → array (21, 3)
  Normaliza los landmarks: mueve la muñeca al origen y escala por el tamaño de la palma.

- `extract_features(landmarks)` → array (15,)
  Extrae un vector de 15 features desde los landmarks normalizados:
  - Features 0-4: ratio de extensión para cada dedo (pulgar, índice, medio, anular, meñique)
  - Feature 5: distancia de pinch (punta pulgar ↔ punta índice)
  - Features 6-9: estado de extensión vertical (índice, medio, anular, meñique)
  - Feature 10: extensión del pulgar horizontal
  - Feature 11: spread total (ángulo entre índice y meñique)
  - Features 12-14: dirección del MCP del dedo medio (orientación de la mano)

- `get_finger_states(landmarks)` → List[bool] (5 valores)
  Retorna qué dedos están extendidos: [pulgar, índice, medio, anular, meñique]

### classifier.py

Contiene el clasificador de señas:

- `SignClassifier` (clase)
  - `train(X, y)`: entrena SVM con kernel RBF
  - `predict(features)` → (sign_id: str, confidence: float)
  - `predict_from_landmarks(raw_landmarks)` → dict completo
  - `save(path)` / `load(path)`: serialización con joblib
  - `get_sign_templates()`: retorna templates para el overlay del frontend

## Cómo mejorar el modelo

El modelo actual se entrena con datos SINTÉTICOS generados en scripts/generate_data.py.
Para mejorar la precisión:

1. Recolectar datos reales:
   ```python
   # scripts/collect_data.py (por crear)
   # Graba landmarks de usuarios reales para cada seña
   ```

2. Reentrenar:
   ```bash
   python scripts/train_model.py --data data/training/real_data.csv
   ```

3. Evaluar:
   ```bash
   python scripts/evaluate_model.py
   ```

## Notas técnicas

- Los landmarks de MediaPipe tienen coordenadas x,y en rango [0,1] del frame
  y z relativo a la muñeca. Después de normalizar, son independientes del tamaño
  de la imagen y la posición de la mano.
- El SVM con kernel RBF funciona bien para señas estáticas. Para señas dinámicas
  (con movimiento) se necesita un modelo secuencial (LSTM, Transformer).
- La confianza se calcula usando `decision_function` del SVM y se mapea a [0, 1].
