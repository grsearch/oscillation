const express = require("express");
const axios = require("axios");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const BINANCE_FUTURES = "https://fapi.binance.com";

let topCoins = [];
let lastScanTime = null;
let scanning = false;

async function scanTopVolatile() {
  if (scanning) return topCoins;
  scanning = true;
  try {
    // Fetch exchange info to get only actively-trading contracts
    const [tickerRes, infoRes] = await Promise.all([
      axios.get(`${BINANCE_FUTURES}/fapi/v1/ticker/24hr`),
      axios.get(`${BINANCE_FUTURES}/fapi/v1/exchangeInfo`),
    ]);
    // Build a Set of symbols currently in TRADING status
    const tradingSymbols = new Set(
      infoRes.data.symbols
        .filter(s => s.status === 'TRADING' && s.contractType === 'PERPETUAL')
        .map(s => s.symbol)
    );
    const res = { data: tickerRes.data };
    const usdt = res.data
      .filter(t => t.symbol.endsWith("USDT")
        && tradingSymbols.has(t.symbol)          // only active perpetuals
        && parseFloat(t.quoteVolume) > 50000000)
      .map(t => {
        const last = parseFloat(t.lastPrice);
        const high = parseFloat(t.highPrice);
        const low = parseFloat(t.lowPrice);
        const amplitude = last > 0 ? ((high - low) / last) * 100 : 0;
        return {
          symbol: t.symbol, lastPrice: last,
          priceChangePercent: parseFloat(t.priceChangePercent),
          highPrice: high, lowPrice: low,
          quoteVolume: parseFloat(t.quoteVolume), amplitude,
          score: amplitude * Math.sqrt(parseFloat(t.quoteVolume) / 1e6),
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
    topCoins = usdt;
    lastScanTime = Date.now();
    console.log(`[${new Date().toLocaleTimeString()}] 扫描完成, Top10:`, usdt.map(c => c.symbol).join(", "));
  } catch (e) { console.error("Scan error:", e.message); }
  scanning = false;
  return topCoins;
}

// Fetch klines with pagination support
async function getKlines(symbol, interval = "1m", limit = 500) {
  const MAX_PER_REQ = 1000;
  try {
    if (limit <= MAX_PER_REQ) {
      const res = await axios.get(`${BINANCE_FUTURES}/fapi/v1/klines`, {
        params: { symbol, interval, limit },
      });
      return res.data.map(k => ({
        time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
        low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
      }));
    }
    let allKlines = [];
    let endTime = undefined;
    let remaining = limit;
    while (remaining > 0) {
      const batch = Math.min(remaining, MAX_PER_REQ);
      const params = { symbol, interval, limit: batch };
      if (endTime) params.endTime = endTime;
      const res = await axios.get(`${BINANCE_FUTURES}/fapi/v1/klines`, { params });
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
  } catch (e) { console.error(`Klines error ${symbol}:`, e.message); return []; }
}

async function getMarkPrice(symbol) {
  try {
    const res = await axios.get(`${BINANCE_FUTURES}/fapi/v1/premiumIndex`, { params: { symbol } });
    return { markPrice: parseFloat(res.data.markPrice), fundingRate: parseFloat(res.data.lastFundingRate) };
  } catch (e) { return { markPrice: 0, fundingRate: 0 }; }
}

async function getFundingRateHistory(symbol, limit = 200) {
  try {
    const res = await axios.get(`${BINANCE_FUTURES}/fapi/v1/fundingRate`, { params: { symbol, limit } });
    return res.data.map(r => ({ fundingTime: r.fundingTime, fundingRate: parseFloat(r.fundingRate) }));
  } catch (e) { console.error(`Funding rate error ${symbol}:`, e.message); return []; }
}

app.get("/api/scan", async (req, res) => {
  const force = req.query.force === "1";
  if (force || !lastScanTime || Date.now() - lastScanTime > 15 * 60 * 1000) await scanTopVolatile();
  res.json({ coins: topCoins, lastScanTime, nextScanIn: lastScanTime ? Math.max(0, 15 * 60 * 1000 - (Date.now() - lastScanTime)) : 0 });
});
app.get("/api/klines/:symbol", async (req, res) => {
  const interval = req.query.interval || "1m";
  const limit = parseInt(req.query.limit) || 500;
  res.json(await getKlines(req.params.symbol, interval, limit));
});
app.get("/api/markprice/:symbol", async (req, res) => res.json(await getMarkPrice(req.params.symbol)));
app.get("/api/fundingrate/:symbol", async (req, res) => {
  const limit = parseInt(req.query.limit) || 200;
  res.json(await getFundingRateHistory(req.params.symbol, limit));
});
app.get("/api/ticker/:symbol", async (req, res) => {
  try { const r = await axios.get(`${BINANCE_FUTURES}/fapi/v1/ticker/24hr`, { params: { symbol: req.params.symbol } }); res.json(r.data); }
  catch (e) { res.json({}); }
});
app.use(express.static(path.join(__dirname, "public")));

scanTopVolatile();
setInterval(scanTopVolatile, 15 * 60 * 1000);
app.listen(PORT, () => {
  console.log(`\n⚡ 震荡猎手 v4 · 改进版`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   npx localtunnel --port ${PORT}\n`);
});
