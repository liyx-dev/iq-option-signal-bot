# LIYOG Blitz AI Signal Engine — Premium Rewrite

This is a signal-only Cloudflare Worker for IQ Option Blitz/OTC manual execution.

## What changed

### 1. Provider-fusion architecture
- Twelve Data: FX reference/history, quota-managed.
- Binance: primary BTC/crypto 1-minute candles.
- CoinGecko: crypto price cross-check, not a 1-minute candle hammer.
- Dukascopy public market-data service: optional FX 1-minute/current-data fallback/reference.
- OANDA: optional authenticated FX provider if you later obtain a demo/API token.
- IQ Option: deliberately isolated behind an adapter boundary. No IQ Option email/password/SSID is accepted by this project.

### 2. Twelve Data protection
The free plan is 8 API credits/minute and 800/day. The engine:
- makes at most one Twelve Data symbol request in a scan window;
- rotates through the FX registry;
- uses local D1 candles for indicators;
- calculates 5m and 15m candles locally from 1m data;
- tracks minute/day quota in D1;
- does not attempt to rotate keys to evade a provider limit.

This means the system can keep analyzing cached/fallback data when Twelve Data returns 429.

### 3. Local quantitative engine
Indicators are calculated inside the Worker:
- EMA 9/21/50
- RSI 14
- MACD
- ADX / +DI / -DI
- ATR
- Bollinger Bands
- momentum
- multi-timeframe trend
- 1m -> 5m -> 15m resampling
- data freshness/quality checks

### 4. AI reviewer
Cloudflare Workers AI is only used after deterministic filtering, so the model does not waste inference on every asset.

Current model:
`@cf/meta/llama-3.1-8b-instruct-fast`

The AI is a conservative reviewer, not a generator of missing market data.

### 5. Timing
Default:
- signal lead: 2 minutes
- expiry: dynamically selected between 1 and 5 minutes

Set `ENTRY_LEAD_MINUTES=3` if you want three minutes of preparation time.

The Worker does not claim to know IQ Option's private server clock. Until an independently verified IQ Option data/time connector is available, the displayed time is WAT converted from Worker UTC time.

## D1 installation

Run the contents of `schema.sql` against the existing `trading_db`.

If you already have the old `signals` table, the migration is additive. Do not delete your old database.

## Secrets / variables

Required for Telegram:
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

Required for Twelve Data FX refresh:
- `TWELVE_DATA_API_KEY`

Optional:
- `COINGECKO_API_KEY`
- `OANDA_API_TOKEN`
- `OANDA_ACCOUNT_ID`
- `OANDA_BASE_URL` (defaults to practice API)
- `ADMIN_SECRET`

Recommended:
- `ENTRY_LEAD_MINUTES=2`
- `MIN_SIGNAL_SCORE=76`
- `MIN_DATA_QUALITY=0.78`
- `MAX_SIGNALS_PER_RUN=3`
- `CANDLE_COUNT=160`

## GitHub / Cloudflare deployment

Your existing GitHub -> Cloudflare deployment can continue. Replace/add the files in this package, commit, and push.

Then:
1. Apply `schema.sql` to D1.
2. Add the secrets/variables in Cloudflare Worker settings.
3. Deploy.
4. Open `/health`.
5. Open `/assets`.
6. Use `/trigger` with `Authorization: Bearer <ADMIN_SECRET>` if `ADMIN_SECRET` is configured.

## Outcome tracking

POST JSON to `/outcome`:

{
  "signal_id": 123,
  "result": "WIN",
  "observed_price": 1.23456,
  "notes": "manual result"
}

This is intentionally manual because the Worker is not connected to an IQ Option trading account.

## Important limitation

External FX data is not identical to IQ Option OTC pricing. The engine therefore labels external data as external and never claims it is the IQ Option OTC feed.

A future IQ Option read-only connector can be plugged into the provider boundary after its authentication and protocol requirements are independently verified.

No system can guarantee a winning rate or 100% accurate signals. The goal here is to make the data pipeline, filtering, timing, measurement and failure handling much stronger and more honest.
