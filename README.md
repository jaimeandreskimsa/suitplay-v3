# SuitPlay Pro — producto (SaaS)

PWA de suscripción para análisis de combinaciones de palo, con login,
registro, prueba gratis y panel de super administración. Motor exacto
validado contra el SuitPlay clásico (9 combinaciones, resultados idénticos).

## Modelo de negocio (SaaS, no por consumo)

- Al registrarse: **7 días de prueba gratis** con uso ilimitado
  (`TRIAL_DAYS` en server.js).
- Después: suscripción **Mensual $9** o **Anual $79** (constante `PLANS`),
  con análisis ilimitados mientras esté activa.
- Suscripción vencida → la app muestra el paywall al intentar calcular.
- Cada análisis se registra como métrica (tabla `usage`), no se cobra por uso.

## Panel de super admin (`/admin`)

Protegido en el servidor (redirige a `/` si no eres admin). Incluye:
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

## Arrancar

```
iniciar.bat                      (o: node --experimental-sqlite server.js)
```

http://localhost:8080. Producción: VPS + proxy HTTPS delante (Caddy, 2
líneas) — HTTPS es obligatorio para PWA instalable fuera de localhost.

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
