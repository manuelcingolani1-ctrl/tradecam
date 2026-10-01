# TradeCam

App de escritorio para grabar tus sesiones de trading intradía (pantalla + cámara + notas) y llevar un journal diario, con cuentas separadas por trader.

## Cómo publicar una nueva versión descargable

Cada vez que quieras que se generen los instaladores de Windows, Mac y Linux:

1. Actualizá el número de versión en `package.json` (campo `"version"`), por ejemplo de `1.0.0` a `1.0.1`.
2. Subí los cambios normales a `main`.
3. Creá y subí un tag con ese mismo número, con el prefijo `v`:
   ```
   git tag v1.0.1
   git push origin v1.0.1
   ```
4. Andá a la pestaña **Actions** del repositorio en GitHub y vas a ver el build corriendo (tarda unos minutos: compila en una Windows, una Mac y una Linux reales, en paralelo).
5. Cuando termina, andá a **Releases** (en la página principal del repo) — ahí vas a encontrar el `.exe` de Windows, el `.dmg` de Mac y el `.AppImage` de Linux, listos para que cualquiera los descargue con un link.

También podés disparar el build sin crear un tag: pestaña **Actions** → **Build & publish TradeCam** → **Run workflow**.

## Conectar Google Drive (almacenamiento en la nube)

En Configuración > Almacenamiento en la nube, el botón "Conectar" de
Google Drive necesita credenciales propias antes de funcionar:

1. Entrá a [console.cloud.google.com](https://console.cloud.google.com), creá un proyecto (por ejemplo "TradeCam").
2. "APIs & Services" → "Library" → buscá "Google Drive API" → "Enable".
3. "APIs & Services" → "OAuth consent screen": tipo "External", nombre "TradeCam", tu email como soporte. En "Test users" agregá tu propia cuenta de Gmail (así queda en modo Testing y no hace falta pasar la verificación de Google para uso personal).
4. En esa misma pantalla, agregá el scope `https://www.googleapis.com/auth/drive.file` (acceso solo a los archivos que TradeCam suba, nunca a todo tu Drive).
5. "APIs & Services" → "Credentials" → "Create Credentials" → "OAuth client ID" → tipo "Desktop app" → nombre "TradeCam Desktop". Te da un **Client ID** y un **Client Secret**.
6. Pegalos en `cloud/google-drive.js`, en las constantes `CLIENT_ID` y `CLIENT_SECRET`.

Los demás proveedores (Dropbox, OneDrive, Cloudflare R2, Backblaze B2,
Firebase Storage) todavía no tienen la conexión real implementada — el
botón "Conectar" avisa que falta esa integración hasta que se sume,
siguiendo el mismo patrón que `cloud/google-drive.js`.

Los tokens se guardan cifrados en el disco (con `safeStorage` de
Electron, que usa el llavero del sistema operativo), nunca en texto
plano ni en el repositorio.

## Desarrollo local

```
npm install
npm start          # abre la app en modo desarrollo
npm run dist:win    # instalador de Windows (necesita Windows, o Linux con wine instalado)
npm run dist:mac    # instalador de Mac (necesita correr en una Mac)
npm run dist:linux  # instalador de Linux (AppImage)
```
