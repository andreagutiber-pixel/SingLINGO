# Plan de commits por integrante

El profesor pidio minimo 5 commits por integrante. Cada computador debe trabajar con su propio usuario de Git y subir cambios reales al repositorio.

## Configuracion en cada computador

```bash
git config user.name "Nombre Apellido"
git config user.email "correo@ejemplo.com"
```

Verificar:

```bash
git config user.name
git config user.email
```

## Flujo recomendado

1. Clonar el repositorio:

```bash
git clone https://github.com/andreagutiber-pixel/SingLINGO.git
cd SingLINGO
```

2. Antes de trabajar, traer cambios:

```bash
git pull origin main
```

3. Hacer un cambio pequeno y real.

4. Guardar el commit:

```bash
git add .
git commit -m "Mensaje descriptivo del cambio"
git push origin main
```

## Reparto sugerido para 3 integrantes

### Integrante 1 - Documentacion y entrega

- Completar nombres de integrantes en `README.md`.
- Agregar capturas o descripcion de la demo.
- Mejorar instrucciones de instalacion.
- Revisar seccion de uso de IA.
- Agregar notas de sustentacion.

### Integrante 2 - Frontend

- Revisar textos visibles en `frontend/index.html`.
- Ajustar estilos en `frontend/css/style.css`.
- Mejorar mensajes de error o ayuda al usuario.
- Revisar flujo de practica.
- Probar y documentar comportamiento de camara.

### Integrante 3 - Backend y datos

- Revisar endpoint `/api/health`.
- Revisar validaciones en `api/models.py`.
- Revisar comentarios o nombres en `api/routes.py`.
- Probar carga de modelos en `core/classifier.py`.
- Revisar archivos de datos en `data/signs/`.

## Ejemplo de mensajes descriptivos

- `Completar nombres de integrantes en README`
- `Mejorar instrucciones de ejecucion local`
- `Ajustar estilos de pantalla principal`
- `Documentar endpoints principales de la API`
- `Revisar catalogo de senas LSC`

## Verificacion final

Antes de entregar:

```bash
git log --oneline --all
git shortlog -sne --all
git status
```

Cada integrante debe aparecer en `git shortlog -sne --all` con al menos 5 commits.
