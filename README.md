# SignLingo - Aprendizaje de Lengua de Señas con IA

## Descripcion

SignLingo es una aplicacion web en Python para practicar lengua de señas con apoyo de vision por computadora e inteligencia artificial. La aplicacion usa la camara del navegador para detectar la mano del usuario, enviar los puntos detectados al backend y comparar la seña realizada con modelos entrenados.

El proyecto busca apoyar a estudiantes y personas interesadas en aprender senas basicas mediante practica visual, retroalimentacion inmediata y seguimiento de progreso.

## Problema que resuelve

Aprender lengua de señas requiere practicar la forma correcta de cada gesto y recibir retroalimentacion. Muchas personas no tienen un instructor disponible todo el tiempo. SignLingo ofrece una herramienta interactiva que permite practicar señas desde el navegador y recibir una prediccion automatica en tiempo real.

## Funcionalidades principales

- Aplicacion web con interfaz para aprender y practicar señas.
- Backend con FastAPI y documentacion Swagger en `/api/docs`.
- Prediccion de señas usando landmarks de la mano enviados desde el navegador.
- Soporte para LSC.
- WebSocket para prediccion en tiempo real.
- Registro de progreso en base de datos SQLite.
- Captura de muestras reales para mejorar el conjunto de datos.
- Visualizacion de confianza, seña detectada y retroalimentacion de la postura.

## Tecnologias utilizadas

- Python 3.11+
- FastAPI
- Uvicorn
- scikit-learn
- NumPy
- Joblib
- SQLite
- HTML, CSS y JavaScript
- MediaPipe Tasks Vision desde CDN en el frontend

## Instalacion

1. Clonar el repositorio:

```bash
git clone https://github.com/andreagutiber-pixel/SingLINGO.git
cd SingLINGO
```

2. Crear y activar un entorno virtual:

```bash
python -m venv .venv
.venv\Scripts\activate
```

3. Instalar dependencias:

```bash
pip install -r requirements.txt
```

## Ejecucion

Iniciar la aplicacion:

```bash
python main.py
```

Luego abrir en el navegador:

```text
http://localhost:5000
```

Documentacion de la API:

```text
http://localhost:5000/api/docs
```

## Estructura del proyecto

```text
SignLingo_proyecto/
|-- main.py
|-- requirements.txt
|-- api/
|   |-- routes.py
|   |-- models.py
|-- core/
|   |-- classifier.py
|   |-- cnn_classifier.py
|   |-- landmarks.py
|   |-- motion_classifier.py
|   |-- sequence_features.py
|-- data/
|   |-- signs/
|   |-- models/
|   |-- training/
|   |-- collected/
|-- frontend/
|   |-- index.html
|   |-- app.html
|   |-- css/
|   |-- js/
|   |-- icons/
|   |-- signs/
```

## Uso de IA

Durante el desarrollo se usaron herramientas de inteligencia artificial como apoyo para:

- Organizar la arquitectura general del proyecto.
- Mejorar explicaciones y documentacion.
- Revisar errores de instalacion y ejecucion.
- Apoyar la escritura de funciones del backend y del frontend.
- Analizar el documento de requisitos del proyecto final.

## Herramientas de IA utilizadas
- Replit
- Codex

El grupo reviso y adapto el codigo generado o sugerido. Cada integrante puede explicar durante la sustentacion la parte del proyecto que trabajo y el funcionamiento general de la aplicacion.

## Integrantes

Completar antes de entregar:

- Integrante 1: Jose Carlos Barreto Toro
- Integrante 2: Maria Jose Cujia Gamez
- Integrante 3:Sally Andrea Gutiérrez Bermúdez

## Notas para la sustentacion

Para la demostracion en vivo se recomienda mostrar:

1. Inicio de la aplicacion con `python main.py`.
2. Pantalla principal en el navegador.
3. Documentacion Swagger en `/api/docs`.
4. Modo de practica con camara.
5. Consulta del endpoint `/api/health`.
6. Explicacion de la estructura `api/`, `core/`, `data/` y `frontend/`.

## Estado de modelos

El proyecto incluye modelos entrenados en `data/models/` para que la demo pueda ejecutarse sin entrenar desde cero. El modelo CNN es opcional; si TensorFlow no esta instalado, la aplicacion principal sigue funcionando con los clasificadores de scikit-learn.
