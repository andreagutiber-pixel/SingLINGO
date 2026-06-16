# Comportamiento de camara

Revision realizada el 2026-06-16 sobre la app local en
`http://localhost:5000/app`.

## Alcance

La prueba revisa el comportamiento visible de la camara en el modo **Practica**.
No se aceptaron permisos de camara desde el navegador durante la automatizacion.

## Pasos probados

1. Levantar el servidor con `python main.py --port 5000 --prod`.
2. Verificar salud de la API en `/api/health`.
3. Abrir `/app` en el navegador.
4. Entrar al modo **Practica** desde la barra superior.
5. Observar el estado inicial del panel de camara y el mensaje de ayuda.

## Resultado observado

- La aplicacion cargo correctamente la seccion principal.
- Al entrar a **Practica**, se activo el flujo de inicio de MediaPipe/camara.
- El navegador devolvio `Permission denied` porque no se concedio permiso de
  camara durante la prueba automatizada.
- La interfaz mostro el prompt:
  - Titulo: `No pudimos activar la camara`
  - Mensaje: `Revisa los permisos del navegador y vuelve a intentarlo. Detalle: Permission denied`
- El estado del HUD de camara permanecio en `Apagada`.
- El elemento `<video id="video">` estuvo presente en el DOM.

## Comportamiento esperado con permiso concedido

Cuando el usuario concede permiso de camara:

1. `MediaPipeHandler.startCamera()` obtiene el stream con `getUserMedia`.
2. El evento `cameraReady` marca el punto de estado como activo.
3. El texto del HUD cambia a `Detectando`.
4. El prompt de camara se elimina.
5. El video se muestra espejado y los overlays dibujan landmarks sobre el
   canvas.

## Casos de recuperacion

- Si el usuario bloquea la camara, debe revisar permisos del navegador y
  recargar o volver a entrar a **Practica**.
- Si otra aplicacion esta usando la camara, debe cerrarla e intentar de nuevo.
- Si MediaPipe no carga, debe verificarse la conexion a internet porque el
  modelo de deteccion se descarga desde CDN.

## Nota de privacidad

El flujo de practica procesa el video en el navegador. El mensaje visible al
usuario aclara que SignLINGO usa la camara solo para reconocer manos y que el
video no se guarda.
