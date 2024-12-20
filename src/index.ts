import { Hono } from "hono";
import axios from "axios";
import { EMA, IchimokuCloud } from "technicalindicators";

const app = new Hono();

interface BinanceKline {
    openTime: number;
    open: string;
    high: string;
    low: string;
    close: string;
    volume: string;
    closeTime: number;
    quoteVolume: string;
    trades: number;
    takerBaseVolume: string;
    takerQuoteVolume: string;
    ignore: string;
}

interface CoinAnalysis {
    symbol: string;
    currentPrice: number;
    timeframes: {
        [key: string]: {
            ema: number;
            kijunSen: number;
            emaCondition: "above" | "below" | "none";
            kijunCondition: "above" | "below" | "none";
        };
    };
    summary: {
        isBelowAllEma: boolean;
        isBelowAllKijun: boolean;
        isBelowAll: boolean;
        isAboveAllEma: boolean;
        isAboveAllKijun: boolean;
        isAboveAll: boolean;
    };
}

const TIMEFRAMES = ["1d", "4h", "1h"];
const COINS = ["BTCUSDT", "ETHUSDT", "BNBUSDT"];

async function fetchKlines(symbol: string, interval: string, limit: number = 200): Promise<BinanceKline[]> {
    const response = await axios.get(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
    const data = response.data;
    return data.map((k: any[]) => ({
        openTime: k[0],
        open: k[1],
        high: k[2],
        low: k[3],
        close: k[4],
        volume: k[5],
        closeTime: k[6],
        quoteVolume: k[7],
        trades: k[8],
        takerBaseVolume: k[9],
        takerQuoteVolume: k[10],
        ignore: k[11],
    }));
}

function calculateIndicators(klines: BinanceKline[]) {
    const prices = klines.map((k) => parseFloat(k.close));
    const currentPrice = prices[prices.length - 1];

    // Calculate EMA
    const emaValues = EMA.calculate({ period: 155, values: prices });
    const ema = emaValues[emaValues.length - 1];

    // Calculate Kijun-sen
    const ichimoku = IchimokuCloud.calculate({
        high: klines.map((k) => parseFloat(k.high)),
        low: klines.map((k) => parseFloat(k.low)),
        conversionPeriod: 55,
        basePeriod: 55,
        spanPeriod: 55,
        displacement: 0,
    });
    const kijunSen = ichimoku[ichimoku.length - 1].base;

    // Define conditions with a small buffer (0.1% to avoid noise)
    const buffer = currentPrice * 0.001;

    const emaCondition = currentPrice > ema + buffer ? "above" : currentPrice < ema - buffer ? "below" : "none";
    const kijunCondition = currentPrice > kijunSen + buffer ? "above" : currentPrice < kijunSen - buffer ? "below" : "none";

    return { ema, kijunSen, emaCondition, kijunCondition };
}

app.get("/analysis", async (c) => {
    try {
        const results: CoinAnalysis[] = [];

        for (const symbol of COINS) {
            const timeframeData: { [key: string]: any } = {};

            // Fetch and analyze each timeframe
            for (const interval of TIMEFRAMES) {
                const klines = await fetchKlines(symbol, interval);
                timeframeData[interval] = calculateIndicators(klines);
            }

            const summary = {
                isBelowAllEma: Object.values(timeframeData).every((tf) => tf.emaCondition === "below"),
                isBelowAllKijun: Object.values(timeframeData).every((tf) => tf.kijunCondition === "below"),
                isBelowAll: Object.values(timeframeData).every((tf) => tf.emaCondition === "below" && tf.kijunCondition === "below"),
                isAboveAllEma: Object.values(timeframeData).every((tf) => tf.emaCondition === "above"),
                isAboveAllKijun: Object.values(timeframeData).every((tf) => tf.kijunCondition === "above"),
                isAboveAll: Object.values(timeframeData).every((tf) => tf.emaCondition === "above" && tf.kijunCondition === "above"),
            };

            results.push({ symbol, currentPrice: parseFloat((await fetchKlines(symbol, "1m", 1))[0].close), timeframes: timeframeData, summary });
        }

        return c.json(results);
    } catch (error) {
        return c.json({ error: "Failed to analyze coins" }, 500);
    }
});

export default app;
