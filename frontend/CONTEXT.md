# frontend/ — Interfaz Web (HTML/CSS/JS)

## ¿Qué hay aquí?

El frontend es una aplicación web que corre en el browser. No requiere build step
(sin webpack, sin npm). Los archivos se sirven directamente desde FastAPI.

## Páginas

### index.html — Landing page
Presentación del proyecto. Efectos visuales con partículas. Botón "Empezar a aprender".

### app.html — Aplicación principal
Contiene 3 modos navegables:
1. **Aprender** — Biblioteca de señas por país, con cards animadas y detalles
2. **Practicar** — Modo cámara con:
   - Feed de video en tiempo real
   - Skeleton de la mano del usuario dibujado sobre el video (canvas overlay)
   - "Mano fantasma" (holographic guide) mostrando la seña objetivo
   - Barra de confianza (similarity score 0-100%)
   - Feedback inmediato cuando la seña es correcta
   - Progresión por lección (seña 1 de 10, etc.)
3. **Progreso** — Dashboard con estadísticas, señas dominadas, racha, gráficas

## Archivos JS

### mediapipe-handler.js
- Carga MediaPipe Tasks Vision desde CDN
- Inicializa el `HandLandmarker` (modelo de 21 landmarks)
- Procesa cada frame del video y emite evento `handDetected` con los landmarks
- Dibuja el skeleton de la mano en el canvas overlay

### api-client.js
- `predictSign(landmarks, country)` → llama POST /api/predict
- `getSigns(country, category)` → llama GET /api/signs
- `saveProgress(data)` → llama POST /api/progress
- `getProgress()` → llama GET /api/progress/summary

### overlay.js
- `drawUserHand(canvas, landmarks)` → dibuja la mano del usuario (verde/rojo)
- `drawGhostHand(canvas, fingerStates)` → dibuja la mano guía (cyan holográfica)
- `drawConfidenceMeter(canvas, confidence)` → barra de similitud visual
- `drawSuccessEffect(canvas)` → animación de éxito (pulso, partículas)

### practice.js
- Lógica del modo práctica: ciclo de señas, detección de éxito, puntuación
- Coordina mediapipe-handler.js → api-client.js → overlay.js

### learn.js
- Renderiza la biblioteca de señas como grid de cards
- Detalles de cada seña con animación al hacer click
- Filtros por país, categoría, dificultad

### app.js
- Controlador principal: navegación entre modos
- Inicialización de la app al cargar

## Stack CDN (sin instalación)

```html
<!-- MediaPipe para detección de manos en browser -->
<script type="module" src="...@mediapipe/tasks-vision"></script>

<!-- GSAP para animaciones suaves -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.2/gsap.min.js"></script>

<!-- Chart.js para gráficas de progreso -->
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
```

## Cómo agregar una nueva pantalla

1. Agregar el HTML dentro de `<div id="app">` en app.html
2. Agregar el botón de navegación en el `<nav>`
3. En app.js, registrar la nueva sección en `SECTIONS` y manejar la navegación
4. Crear el archivo JS correspondiente en `frontend/js/`

## Tema visual

- Fondo: #0a0a14 (negro azulado muy oscuro)
- Acento primario: #00f5c8 (cyan neon)
- Acento secundario: #7c3aed (violeta)
- Texto: #e0e0ff (blanco azulado)
- Cards: glassmorphism (backdrop-filter: blur + border rgba)
- Efectos: text-shadow y box-shadow con glow cyan/violeta
