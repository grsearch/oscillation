const express = require("express");
const axios = require("axios");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const BINANCE_FUTURES = "https://fapi.binance.com";

// Axios instance with timeout
const api = axios.create({ timeout: 10000 });

let topCoins = [];
let lastScanTime = null;
let scanning = false;

async function scanTopVolatile() {
  if (scanning) return topCoins;
  scanning = true;
  try {
    // Fetch exchangeInfo and 24hr ticker in parallel
    const [tickerRes, infoRes] = await Promise.all([
      api.get(`${BINANCE_FUTURES}/fapi/v1/ticker/24hr`),
      api.get(`${BINANCE_FUTURES}/fapi/v1/exchangeInfo`),
    ]);

    // Only keep TRADING PERPETUAL contracts — filters out delisted/pre-delivery/settling symbols
    const tradingSymbols = new Set(
      infoRes.data.symbols
        .filter(s => s.status === 'TRADING' && s.contractType === 'PERPETUAL')
        .map(s => s.symbol)
    );
    console.log(`[Scan] TRADING PERPETUAL contracts: ${tradingSymbols.size}`);

    const usdt = tickerRes.data
      .filter(t =>
        t.symbol.endsWith("USDT") &&
        tradingSymbols.has(t.symbol) &&          // ← delisted coins excluded here
        parseFloat(t.quoteVolume) > 50_000_000   // min 50M USDT 24h volume
      )
      .map(t => {
        const last = parseFloat(t.lastPrice);
        const high = parseFloat(t.highPrice);
        const low  = parseFloat(t.lowPrice);
        const amplitude = last > 0 ? ((high - low) / last) * 100 : 0;
        return {
          symbol: t.symbol,
          lastPrice: last,
          priceChangePercent: parseFloat(t.priceChangePercent),
          highPrice: high,
          lowPrice: low,
          quoteVolume: parseFloat(t.quoteVolume),
          amplitude,
          score: amplitude * Math.sqrt(parseFloat(t.quoteVolume) / 1e6),
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);

    topCoins = usdt;
    lastScanTime = Date.now();
    console.log(`[${new Date().toLocaleTimeString()}] 扫描完成 Top10: ${usdt.map(c => c.symbol).join(", ")}`);
  } catch (e) {
    console.error("Scan error:", e.message);
    // Don't wipe topCoins on error — keep the last good result
  }
  scanning = false;
  return topCoins;
}

// Fetch klines — supports large limits via pagination
async function getKlines(symbol, interval = "1m", limit = 500) {
  const MAX_PER_REQ = 1000;
  try {
    if (limit <= MAX_PER_REQ) {
      const res = await api.get(`${BINANCE_FUTURES}/fapi/v1/klines`, {
        params: { symbol, interval, limit },
      });
      return res.data.map(k => ({
        time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
        low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
      }));
    }
    // Paginate for limits > 1000
    let allKlines = [];
    let endTime;
    let remaining = limit;
    while (remaining > 0) {
      const batch = Math.min(remaining, MAX_PER_REQ);
      const params = { symbol, interval, limit: batch };
      if (endTime) params.endTime = endTime;
      const res = await api.get(`${BINANCE_FUTURES}/fapi/v1/klines`, { params });
      if (!res.data.length) break;
      const klines = res.data.map(k => ({
        time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
        low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
      }));
      allKlines = [...klines, ...allKlines];
      endTime = res.data[0][0] - 1;
      remaining -= res.data.length;
      if (res.data.length < batch) break;
    }
    return allKlines;
  } catch (e) {
    console.error(`Klines error ${symbol}:`, e.message);
    return [];
  }
}

async function getFundingRateHistory(symbol, limit = 200) {
  try {
    const res = await api.get(`${BINANCE_FUTURES}/fapi/v1/fundingRate`, { params: { symbol, limit } });
    return res.data.map(r => ({
      fundingTime: r.fundingTime,
      fundingRate: parseFloat(r.fundingRate),
    }));
  } catch (e) {
    console.error(`Funding rate error ${symbol}:`, e.message);
    return [];
  }
}

// ── Routes ──
app.get("/api/scan", async (req, res) => {
  const force = req.query.force === "1";
  if (force || !lastScanTime || Date.now() - lastScanTime > 15 * 60 * 1000) {
    await scanTopVolatile();
  }
  res.json({
    coins: topCoins,
    lastScanTime,
    nextScanIn: lastScanTime ? Math.max(0, 15 * 60 * 1000 - (Date.now() - lastScanTime)) : 0,
  });
});

app.get("/api/klines/:symbol", async (req, res) => {
  const interval = req.query.interval || "1m";
  const limit = Math.min(parseInt(req.query.limit) || 500, 2000);
  res.json(await getKlines(req.params.symbol, interval, limit));
});

app.get("/api/fundingrate/:symbol", async (req, res) => {
  const limit = parseInt(req.query.limit) || 200;
  res.json(await getFundingRateHistory(req.params.symbol, limit));
});

app.get("/api/markprice/:symbol", async (req, res) => {
  try {
    const r = await api.get(`${BINANCE_FUTURES}/fapi/v1/premiumIndex`, { params: { symbol: req.params.symbol } });
    res.json({ markPrice: parseFloat(r.data.markPrice), fundingRate: parseFloat(r.data.lastFundingRate) });
  } catch (e) { res.json({ markPrice: 0, fundingRate: 0 }); }
});

app.use(express.static(path.join(__dirname, "public")));

scanTopVolatile();
setInterval(scanTopVolatile, 15 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`\n⚡ 震荡猎手 v4 · 改进版`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   npx localtunnel --port ${PORT}\n`);
});
