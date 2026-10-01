# CamTrader

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

También podés disparar el build sin crear un tag: pestaña **Actions** → **Build & publish CamTrader** → **Run workflow**.

## Conectar Google Drive (almacenamiento en la nube)

En Configuración > Almacenamiento en la nube, el botón "Conectar" de
Google Drive necesita credenciales propias antes de funcionar. Este repo
es **público**, así que esas credenciales nunca se suben a git: viven en
`cloud/credentials.local.json` (gitignoreado) para correr la app en tu
compu, y en un secret de GitHub Actions para que los instaladores que
genera el workflow también las lleven adentro.

1. Entrá a [console.cloud.google.com](https://console.cloud.google.com), creá un proyecto (por ejemplo "CamTrader").
2. "APIs & Services" → "Library" → buscá "Google Drive API" → "Enable".
3. "APIs & Services" → "OAuth consent screen": tipo "External", nombre "CamTrader", tu email como soporte. En "Test users" agregá tu propia cuenta de Gmail (así queda en modo Testing y no hace falta pasar la verificación de Google para uso personal).
4. En esa misma pantalla, agregá el scope `https://www.googleapis.com/auth/drive.file` (acceso solo a los archivos que CamTrader suba, nunca a todo tu Drive).
5. "APIs & Services" → "Credentials" → "Create Credentials" → "OAuth client ID" → tipo "Desktop app" → nombre "CamTrader Desktop". Te da un **Client ID** y un **Client Secret**.
6. Copiá `cloud/credentials.local.json.example` a `cloud/credentials.local.json` (este archivo NO se sube a git) y completá ahí `clientId` y `clientSecret` con esos valores.
7. Para que los instaladores automáticos (GitHub Actions) también los lleven: en el repo, "Settings" → "Secrets and variables" → "Actions" → "New repository secret". Nombre: `CLOUD_CREDENTIALS_JSON`. Valor: el contenido completo de tu `cloud/credentials.local.json` (el JSON entero, tal cual).

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
