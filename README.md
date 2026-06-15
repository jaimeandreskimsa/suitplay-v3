# SuitPlay Pro — producto

PWA para análisis de combinaciones de palo. Motor exacto validado contra el
SuitPlay clásico (`SuitPlay.exe`) — probabilidades idénticas, decimal a decimal,
en todas las combinaciones comparadas.

## Modo de acceso

Por defecto la app es de **acceso libre** (sin login), para subirla y probarla
sin registrarse. Para activar el modo **SaaS** completo (registro, login, prueba
gratis, suscripción y paywall) arranca con:

```
set AUTH_DISABLED=0
```

Con el modo SaaS desactivado (por defecto) toda la API responde como un usuario
local con acceso ilimitado y el panel `/admin` queda accesible.

## Motor de cálculo

- **Modelo**: declarante single-dummy contra defensa óptima omnisciente
  (best defense), idéntico al SuitPlay clásico.
- **Optimización**: el solver colapsa dinámicamente las distribuciones
  estructuralmente equivalentes (cartas intercambiables), igual que el EXE.
  La mayoría de combinaciones se resuelven en menos de 1 s.
- **Límite**: las combinaciones con honores de la defensa muy repartidos
  (cada carta aislada entre cartas N/S) tienen una frontera de estrategias
  intrínsecamente enorme y pueden superar el tiempo límite del cálculo
  (60 s); en ese caso la UI muestra un aviso y se puede cancelar. Igualar al
  EXE en esos casos requiere su algoritmo de representación compacta.

## Modelo de negocio (SaaS, no por consumo) — `AUTH_DISABLED=0`

- Al registrarse: **7 días de prueba gratis** con uso ilimitado
  (`TRIAL_DAYS` en server.js).
- Después: suscripción **Mensual $9** o **Anual $79** (constante `PLANS`),
  con análisis ilimitados mientras esté activa.
- Suscripción vencida → la app muestra el paywall al intentar calcular.
- Cada análisis se registra como métrica (tabla `usage`), no se cobra por uso.

## Panel de super admin (`/admin`)

En modo abierto (por defecto) es accesible directamente. En modo SaaS está
protegido en el servidor (redirige a `/` si no eres admin). Incluye:
- **Métricas**: usuarios totales, suscripciones activas, en prueba,
  vencidos, ingresos acumulados y nº de pagos, análisis últimos 30 días/total.
- **Usuarios**: correo, plan, estado, fecha de vencimiento, análisis
  realizados, último uso, fecha de registro, filtro por correo y botón
  **+30 días** (cortesía/soporte).
- **Pagos**: fecha, correo, plan, importe y sesión de Stripe de cada cobro.

Para nombrar al primer admin:
```
node --experimental-sqlite server.js admin tucorreo@dominio.com
```

## Arquitectura (elegida por velocidad y simplicidad)

- **Servidor**: Node.js puro, **cero dependencias** (`node:http`,
  `node:sqlite`, `node:crypto`). Arranca en milisegundos.
- **Cálculo en el cliente** (Web Worker): el servidor no gasta CPU en los
  análisis — escala a miles de usuarios con una máquina mínima.
- **PWA**: instalable, service worker, shell offline.
- **BD**: SQLite en `data/suitplay.db` — copiar el archivo = backup.
- **Favoritos**: cada usuario guarda combinaciones en su cuenta (tabla
  `favorites`, endpoints `GET/POST /api/favorites` y `POST /api/favorites/delete`);
  sincronizan entre dispositivos y se cachean en el cliente para verlas offline.

## Arrancar

```
iniciar.bat                      (o: node --experimental-sqlite server.js)
```

http://localhost:8080. Producción: VPS + proxy HTTPS delante (Caddy, 2
líneas) — HTTPS es obligatorio para PWA instalable fuera de localhost.

## Desplegar en Railway

1. Sube esta carpeta (`producto/`) como repo a GitHub y crea en Railway un
   proyecto "Deploy from GitHub repo". Detecta Node por `package.json` y
   arranca con `npm start` (requiere Node 22.5+, ver `engines`).
2. **Volumen para la BD** (el filesystem es efímero): añade un Volume al
   servicio montado en `/data` y define la variable `DATA_DIR=/data`.
   Sin esto, usuarios/pagos se pierden en cada deploy (en modo abierto solo
   se perderían métricas).
3. Variables opcionales: `AUTH_DISABLED=0` (modo SaaS con cuentas),
   `STRIPE_SECRET_KEY=sk_live_...` (pagos).
4. Railway publica con HTTPS en `*.up.railway.app` → la PWA es instalable
   directamente. `PORT` lo inyecta Railway y el servidor ya lo lee.

## Pagos (Stripe, modo suscripción)

1. Cuenta en stripe.com → clave secreta.
2. `set STRIPE_SECRET_KEY=sk_live_...` y arrancar.
3. El checkout crea una **suscripción recurrente** real; al volver se
   activa el plan verificando el pago server-side (idempotente). Las
   renovaciones se verifican de forma diferida contra Stripe cuando el
   periodo local vence.

Sin clave: el botón de compra muestra "contacta al administrador" y puedes
activar manualmente con `grant`:
```
node --experimental-sqlite server.js grant cliente@x.com 30    (+30 días)
```

## Seguridad

- Contraseñas scrypt + salt; sesiones httpOnly SameSite=Lax (30 días) en BD.
- Rate-limiting en login/registro (12/min/IP).
- Suscripción verificada server-side en cada análisis; panel y API admin
  protegidos por flag `is_admin` en servidor.

## Estructura

```
producto/
  server.js            servidor completo (estáticos + API + Stripe + admin)
  iniciar.bat          arranque en Windows
  data/suitplay.db     base de datos (se crea sola)
  public/
    index.html         la app (login, análisis, play, paywall)
    admin.html         panel de super admin
    engine.js          motor de cálculo exacto
    worker.js          worker de cálculo
    manifest.webmanifest, sw.js, icon.svg, icon-192/512.png   (PWA)
```
