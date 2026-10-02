#!/usr/bin/env python3
"""
Puente entre TradeCam y la terminal de MetaTrader 5 instalada en esta
computadora. TradeCam (proceso principal de Electron, main.js) ejecuta este
script y le pasa un pedido como JSON por stdin; este script le contesta un
JSON por stdout con las velas pedidas o un error legible.

Requiere:
  - Python 3 instalado en esta computadora.
  - El paquete `MetaTrader5` instalado (pip install MetaTrader5).
  - La terminal de MetaTrader 5 abierta y logueada en la cuenta desde la que
    se quieren traer velas (la librería se conecta a esa terminal ya
    abierta, no abre una sesión propia).

Pedido esperado por stdin (un solo JSON, una sola línea):
  {"symbol": "NAS100", "timeframe": "M5", "fromTs": 1696118400, "toTs": 1696204800}

  - symbol: nombre exacto del símbolo tal como aparece en el Market Watch
    de tu MT5 (puede variar según el bróker, ej. "NAS100", "US100", "NAS100.cash").
  - timeframe: uno de M1, M5, M15, M30, H1, H4, D1.
  - fromTs / toTs: timestamps UNIX en segundos (UTC).

Respuesta por stdout (un solo JSON):
  {"ok": true, "candles": [{"time":..., "open":..., "high":..., "low":..., "close":..., "volume":...}, ...]}
  {"ok": false, "error": "mensaje legible en español"}
"""
import sys
import json
from datetime import datetime, timezone


def fail(msg):
    print(json.dumps({"ok": False, "error": msg}))
    sys.exit(0)


def main():
    raw = sys.stdin.read()
    try:
        req = json.loads(raw)
    except Exception as e:
        fail("No se pudo leer el pedido (JSON inválido): " + str(e))
        return

    symbol = req.get("symbol")
    timeframe_str = (req.get("timeframe") or "M5").upper()
    from_ts = req.get("fromTs")
    to_ts = req.get("toTs")

    if not symbol:
        fail("Falta el símbolo.")
        return
    if from_ts is None or to_ts is None:
        fail("Falta el rango de fechas (fromTs/toTs).")
        return

    try:
        import MetaTrader5 as mt5
    except ImportError:
        fail(
            "No está instalado el paquete MetaTrader5 de Python. "
            "Abrí una terminal en tu computadora y corré: pip install MetaTrader5"
        )
        return

    TF_MAP = {
        "M1": mt5.TIMEFRAME_M1,
        "M5": mt5.TIMEFRAME_M5,
        "M15": mt5.TIMEFRAME_M15,
        "M30": mt5.TIMEFRAME_M30,
        "H1": mt5.TIMEFRAME_H1,
        "H4": mt5.TIMEFRAME_H4,
        "D1": mt5.TIMEFRAME_D1,
    }
    tf = TF_MAP.get(timeframe_str)
    if tf is None:
        fail("Timeframe inválido: " + str(timeframe_str))
        return

    if not mt5.initialize():
        err = mt5.last_error()
        fail(
            "No se pudo conectar con la terminal de MetaTrader 5 (" + str(err) + "). "
            "Abrí MT5 en esta computadora, logueate en tu cuenta y probá de nuevo."
        )
        return

    try:
        if not mt5.symbol_select(symbol, True):
            fail(
                "El símbolo '" + str(symbol) + "' no existe o no está visible en el "
                "Market Watch de tu MT5. Agregalo ahí (clic derecho → Mostrar todos) "
                "y fijate el nombre exacto que usa tu bróker."
            )
            return

        date_from = datetime.fromtimestamp(int(from_ts), tz=timezone.utc)
        date_to = datetime.fromtimestamp(int(to_ts), tz=timezone.utc)
        rates = mt5.copy_rates_range(symbol, tf, date_from, date_to)

        if rates is None:
            err = mt5.last_error()
            fail("MT5 no devolvió velas para ese rango (" + str(err) + ").")
            return

        candles = []
        for r in rates:
            candles.append({
                "time": int(r["time"]),
                "open": float(r["open"]),
                "high": float(r["high"]),
                "low": float(r["low"]),
                "close": float(r["close"]),
                "volume": float(r["tick_volume"]),
            })
        print(json.dumps({"ok": True, "candles": candles}))
    finally:
        mt5.shutdown()


if __name__ == "__main__":
    main()
