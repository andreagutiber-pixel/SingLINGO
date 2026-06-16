# Catalogos de senas

Esta carpeta contiene los catalogos que usa la aplicacion para mostrar y clasificar senas.

## Archivos revisados

| Archivo | Idioma | Cantidad | Categorias |
|---|---|---:|---|
| `asl.json` | American Sign Language | 26 | `alphabet`, `words` |
| `bsl.json` | British Sign Language | 15 | `basic`, `feelings`, `greetings`, `nouns` |
| `lsc.json` | Lengua de Senas Colombiana | 54 | `alphabet`, `basic`, `feelings`, `words` |

## Campos principales

Cada sena debe incluir como minimo:

- `id`: identificador unico de la sena.
- `name`: nombre visible en la interfaz.
- `category`: grupo al que pertenece.
- `difficulty`: nivel de dificultad.
- `finger_states`: estado esperado de los dedos.

Tambien pueden aparecer campos como `tips`, `description`, `two_handed`, `body_zone`, `requires_pose`, `requires_motion` y `motion_type`.

## Validacion realizada

Se reviso que los tres archivos JSON carguen correctamente, que no tengan IDs duplicados y que cada sena incluya los campos basicos necesarios para la aplicacion.
