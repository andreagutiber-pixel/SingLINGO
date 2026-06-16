# Flujo de practica

Este documento resume el comportamiento esperado del modo **Practica** despues de
la revision de frontend. No introduce cambios de logica; sirve como guia para
probar el flujo antes de entregar.

## Entrada al modo

1. El usuario entra a `/app` y selecciona **Practica** en la barra superior.
2. La aplicacion prepara una leccion de LSC con un grupo de senas del alfabeto.
3. El panel izquierdo muestra la sena objetivo, su nombre y las instrucciones.
4. El panel central queda listo para pedir permiso de camara.

## Inicio de sesion

1. Al iniciar, se carga MediaPipe si todavia no estaba listo.
2. Se muestra el mensaje de permiso de camara.
3. Cuando el navegador autoriza la camara, el estado cambia a **Detectando**.
4. El temporizador y el puntaje comienzan desde cero.

## Practica de una sena

1. El usuario coloca la mano completa frente a la camara.
2. MediaPipe detecta landmarks y el overlay dibuja la mano sobre el video.
3. La prediccion se envia al predictor WebSocket cuando esta disponible; si no,
   usa el endpoint HTTP de prediccion.
4. El panel derecho muestra la letra detectada, similitud y posicion de dedos.
5. Si la postura no coincide, aparecen pistas como levantar o bajar un dedo.
6. Para aceptar una respuesta, la prediccion debe mantenerse estable varios
   frames y superar la confianza minima configurada.
7. Al acertar, se suma puntaje, aparece la animacion de correcto y avanza a la
   siguiente sena.

## Senas dinamicas

Algunas senas tienen dos fases:

1. **Fija la posicion**: el usuario mantiene la postura base.
2. **Ahora mueve**: el usuario realiza el trazo o movimiento indicado.

La interfaz muestra una barra de progreso para la fase de posicion y una pista
de movimiento cuando corresponde.

## Cierre o reinicio

- **Saltar sena** avanza a la siguiente sena de la leccion.
- **Reiniciar intento** vuelve al inicio de la misma leccion y reinicia puntaje.
- **Salir de sesion** detiene la camara, desconecta el predictor y apaga el
  temporizador.
- Al completar todas las senas, se muestra la tarjeta de leccion completada.

## Resultado de la revision

- El flujo mantiene la secuencia original de carga, permiso, deteccion,
  prediccion, feedback y avance.
- Los cambios realizados en esta revision se limitaron a textos, estilos y
  documentacion.
- No se alteraron umbrales de confianza, seleccion de lecciones, eventos de
  MediaPipe ni llamadas a la API.
