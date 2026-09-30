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

## Desarrollo local

```
npm install
npm start          # abre la app en modo desarrollo
npm run dist:win    # instalador de Windows (necesita Windows, o Linux con wine instalado)
npm run dist:mac    # instalador de Mac (necesita correr en una Mac)
npm run dist:linux  # instalador de Linux (AppImage)
```
