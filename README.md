# JS WSP Verificación

API en Node.js (Express) que crea sesiones de WhatsApp por DNI y permite verificar si un número está registrado en WhatsApp usando `whatsapp-web.js`.

## Requisitos

- Node.js 18+ (recomendado 20)
- Opcional: Docker + Docker Compose

## Variables de entorno

- `RESET_WWEBJS`:
  - `true`: borra `.wwebjs_auth` y `.wwebjs_cache` al iniciar
  - `false` (default): conserva sesiones/caché

## Ejecutar en local

1. Instalar dependencias:

   ```bash
   npm install
   ```

2. Iniciar:

   ```bash
   node index.js
   ```

La API queda en `http://localhost:3009`.

## Ejecutar con Docker

### Con Docker Compose (recomendado)

```bash
docker compose up --build
```

Por defecto persiste las sesiones en volúmenes Docker.

### Con Docker run

```bash
docker build -t wsp-verificacion-api .
docker run --rm -p 3009:3009 wsp-verificacion-api
```

## Endpoints

### GET /auth?dni=...

Crea (si no existe) o consulta el estado de la sesión para el `dni`. Cuando hay QR pendiente, devuelve un DataURL.

Ejemplos:

```bash
curl "http://localhost:3009/auth?dni=12345678"
```

Respuestas típicas:

- `{ "status": "creando", "mensaje": "Generando QR..." }`
- `{ "status": "pendiente", "qr": "data:image/png;base64,..." }`
- `{ "status": "conectando", "mensaje": "Esperando conexión..." }`
- `{ "status": "conectado" }`

### GET /verificar?dni=...&numero=...

Verifica un número (10 a 15 dígitos) contra la sesión del `dni`.

```bash
curl "http://localhost:3009/verificar?dni=12345678&numero=51999999999"
```

Respuesta:

```json
{
  "dni": "12345678",
  "numero": "51999999999",
  "tiene_whatsapp": true
}
```

### POST /verificar-masivo

Verificación masiva con pausa aleatoria entre consultas.

Body:

```json
{
  "dni": "12345678",
  "numeros": ["51999999999", "51988888888"]
}
```

Ejemplo:

```bash
curl -X POST "http://localhost:3009/verificar-masivo" \
  -H "Content-Type: application/json" \
  -d "{\"dni\":\"12345678\",\"numeros\":[\"51999999999\",\"51988888888\"]}"
```

Respuesta:

```json
{
  "total": 2,
  "resultados": [
    { "numero": "51999999999", "tiene_whatsapp": true },
    { "numero": "51988888888", "tiene_whatsapp": false }
  ]
}
```

## Notas

- Para que `/verificar` y `/verificar-masivo` funcionen, primero el `dni` debe estar conectado (escaneando el QR devuelto por `/auth`).
- El rate limit está aplicado por `dni` para evitar spam de requests seguidos.
