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

## Conectar Dropbox (almacenamiento en la nube)

Igual que con Google Drive: el botón "Conectar" de Dropbox en
Configuración > Almacenamiento en la nube necesita credenciales propias
antes de funcionar, y nunca se suben a git — viven en
`cloud/credentials.local.json` (gitignoreado) para correr la app en tu
compu, y en el mismo secret de GitHub Actions para que los instaladores
también las lleven adentro.

1. Entrá a [dropbox.com/developers/apps](https://www.dropbox.com/developers/apps) con tu cuenta de Dropbox y hacé clic en "Create app".
2. Elegí "Scoped access", después "App folder" (así la app solo puede escribir dentro de una carpeta propia, `/CamTrader`, nunca en el resto de tu Dropbox). Ponele un nombre, por ejemplo "CamTrader".
3. Ya dentro de la app creada, pestaña "Permissions": tildá `account_info.read`, `files.content.write` y `files.metadata.read`, y después "Submit" al final de la página.
4. Pestaña "Settings": en "OAuth 2" → "Redirect URIs" agregá exactamente `http://127.0.0.1:42814/callback` (ese puerto es el que usa CamTrader para recibir la respuesta de Dropbox; tiene que ser idéntico, sin barra final extra).
5. En esa misma pestaña vas a ver el **App key** y el **App secret** (hacé clic en "Show" para verlo).
6. Copiá `cloud/credentials.local.json.example` a `cloud/credentials.local.json` si todavía no existe (este archivo NO se sube a git) y completá ahí, dentro de la clave `"dropbox"`, `appKey` y `appSecret` con esos valores.
7. Para que los instaladores automáticos (GitHub Actions) también los lleven: actualizá el secret `CLOUD_CREDENTIALS_JSON` en el repo ("Settings" → "Secrets and variables" → "Actions") con el contenido completo y actualizado de tu `cloud/credentials.local.json` (con `gdrive` y `dropbox` juntos en el mismo JSON).

Las grabaciones que se suben a Dropbox quedan dentro de una carpeta
`/CamTrader` en la raíz de tu Dropbox (se crea sola la primera vez que
subís algo). Si ya existe un archivo con el mismo nombre, Dropbox le
agrega un sufijo automáticamente en vez de pisarlo.

Los demás proveedores (OneDrive, Cloudflare R2, Backblaze B2, Firebase
Storage) todavía no tienen la conexión real implementada — el botón
"Conectar" avisa que falta esa integración hasta que se sume, siguiendo
el mismo patrón que `cloud/google-drive.js` y `cloud/dropbox.js`.

## Conectar Cloudflare R2 (almacenamiento en la nube)

A diferencia de Google Drive y Dropbox, R2 no usa un login por
navegador: se conecta con una API key fija que generás una sola vez.
Igual que los otros, esa credencial nunca se sube a git — vive en
`cloud/credentials.local.json` (gitignoreado) y en el secret de GitHub
Actions.

1. Entrá a [dash.cloudflare.com](https://dash.cloudflare.com) (creá una cuenta si no tenés) y andá a **"R2 Object Storage"** en el menú de la izquierda.
2. Si es la primera vez, activá R2 (tiene un nivel gratis de 10 GB/mes; no te cobra nada mientras te quedes debajo de eso).
3. **"Create bucket"** → nombre en minúsculas, por ejemplo `camtrader` → "Create bucket".
4. Volvé a la pantalla principal de R2 y buscá **"Manage R2 API Tokens"** → **"Create Account API token"**.
5. Nombre: `CamTrader`. Permisos: **"Object Read & Write"**. Aplicalo al bucket que creaste (o a todos si no te deja elegir uno solo). **"Create API Token"**.
6. Te va a mostrar un **Access Key ID** y un **Secret Access Key** (copialos, el secret no se puede volver a ver después) y un endpoint tipo `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` — el `ACCOUNT_ID` es esa parte de la URL.
7. Copiá `cloud/credentials.local.json.example` a `cloud/credentials.local.json` si todavía no existe, y completá dentro de `"r2"`: `accountId`, `accessKeyId`, `secretAccessKey` y `bucketName` (el nombre exacto del bucket, en minúsculas).
8. Actualizá el secret `CLOUD_CREDENTIALS_JSON` en GitHub con el JSON completo (`gdrive`, `dropbox` y `r2` juntos).

**Tope de seguridad para no generar cargos:** como R2 cobra por arriba de
los 10 GB gratis mensuales, CamTrader calcula cuánto ocupan ya las
grabaciones subidas y, si la próxima subida haría que el total supere el
`safetyCapGB` configurado (9.5 GB por defecto, dejando un margen), **no
sube a R2** y prueba automáticamente con el siguiente proveedor
conectado en la lista de prioridad de Configuración — nunca se arriesga
a pasarse del límite gratis solo. Para cambiar ese tope (por ejemplo si
contrataste más espacio a propósito), agregá `"safetyCapGB": 50` (o el
número que quieras) dentro de `"r2"` en `credentials.local.json`.

Las grabaciones quedan dentro de una carpeta lógica `CamTrader/` en el
bucket. Una grabación de más de 5 GB no se puede subir todavía (hace
falta "subida multipart", que no está implementada) — en ese caso la app
avisa con un error claro y el video queda solo en tu computadora.

## Conectar Backblaze B2 (almacenamiento en la nube)

Igual que R2: API compatible con S3, sin login por navegador, con una
API key fija.

1. Creá una cuenta en [backblaze.com/sign-up/cloud-storage](https://www.backblaze.com/sign-up/cloud-storage) (nivel gratis: 10 GB).
2. **"B2 Cloud Storage"** → **"Buckets"** → **"Create a Bucket"**. Nombre único a nivel mundial (si `camtrader` ya está tomado, probá `camtrader-` + algo tuyo). Files in Bucket: **"Private"**.
3. Entrá al bucket creado y copiá el **"Endpoint"** que muestra (por ejemplo `s3.us-west-004.backblazeb2.com`).
4. **"Application Keys"** → **"Add a New Application Key"** → nombre `CamTrader`, restringido al bucket que creaste, acceso **"Read and Write"** → **"Create New Key"**.
5. Copiá el **`keyID`** y el **`applicationKey`** (este último solo se muestra una vez).
6. Completá dentro de `"b2"` en `cloud/credentials.local.json`: `endpoint`, `keyId`, `applicationKey` y `bucketName` (el nombre exacto que le diste).
7. Actualizá el secret `CLOUD_CREDENTIALS_JSON` en GitHub con el JSON completo (los cuatro proveedores juntos).

Mismo tope de seguridad configurable que R2 (`safetyCapGB` dentro de
`"b2"`, 9.5 GB por defecto) y la misma limitación de 5 GB por archivo
(sin subida multipart todavía).

## Desarrollo local

```
npm install
npm start          # abre la app en modo desarrollo
npm run dist:win    # instalador de Windows (necesita Windows, o Linux con wine instalado)
npm run dist:mac    # instalador de Mac (necesita correr en una Mac)
npm run dist:linux  # instalador de Linux (AppImage)
```
