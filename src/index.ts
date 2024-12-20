import { Hono } from "hono";
import TelegramBot from "node-telegram-bot-api";
import { EMA, IchimokuCloud } from "technicalindicators";

const TELEGRAM_BOT_TOKEN = "8063871104:AAEjiCPViaiPJds8-BZb6CCwlXCwgGFHXYc";

const app = new Hono();
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: { autoStart: true, params: { timeout: 10 } } });

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
const COINS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT", "DOGEUSDT", "MATICUSDT", "SOLUSDT", "DOTUSDT", "LTCUSDT"];

// Add delay utility function
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Rate limiting configuration
const RATE_LIMIT = { WEIGHT_PER_MINUTE: 1200, REQUESTS_PER_FIVE_MINUTES: 6000, SAFETY_FACTOR: 0.8 };

// Improved fetch with rate limiting
class RateLimiter {
    private lastRequestTime: number = 0;
    private requestsInWindow: number = 0;
    private readonly minDelayMs: number;

    constructor() {
        // Calculate minimum delay between requests to stay within limits
        // Using the more restrictive of the two limits
        const requestsPerMinute = RATE_LIMIT.WEIGHT_PER_MINUTE * RATE_LIMIT.SAFETY_FACTOR;
        this.minDelayMs = (60 * 1000) / requestsPerMinute;
    }

    async wait() {
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;

        if (timeSinceLastRequest < this.minDelayMs) {
            await delay(this.minDelayMs - timeSinceLastRequest);
        }

        this.lastRequestTime = Date.now();
        this.requestsInWindow++;
    }
}

const rateLimiter = new RateLimiter();

async function fetchWithRetry(symbol: string, interval: string, retries = 3): Promise<BinanceKline[]> {
    for (let i = 0; i < retries; i++) {
        try {
            await rateLimiter.wait(); // Wait for rate limit

            const response = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${200}`);

            if (!response.ok) {
                const error = await response.text();
                throw new Error(`HTTP error! status: ${response.status}, message: ${error}`);
            }

            const data = await response.json();
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
        } catch (error: any) {
            console.error(`Attempt ${i + 1} failed for ${symbol} ${interval}:`, error);

            if (error.message.includes("429")) {
                // Rate limit exceeded
                await delay(5000); // Wait longer on rate limit errors
            } else if (i === retries - 1) {
                throw error;
            }

            await delay(1000 * (i + 1)); // Exponential backoff
        }
    }
    throw new Error("Failed after retries");
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

// Handle /check command
bot.onText(/\/check/, async (msg) => {
    const chatId = msg.chat.id;

    try {
        // Create initial progress message
        const progressText = COINS.map((coin) => `${coin}: ⏳ Waiting...`).join("\n");
        const progressMsg = await bot.sendMessage(chatId, `Analysis Progress:\n${progressText}`);

        // Process coins sequentially
        for (let i = 0; i < COINS.length; i++) {
            const coin = COINS[i];
            try {
                // Update progress message
                const updatedProgress = COINS.map((c, index) => {
                    if (index < i) return `${c}: ✅ Done`;
                    if (index === i) return `${c}: 🔄 Analyzing...`;
                    return `${c}: ⏳ Waiting...`;
                }).join("\n");

                await bot.editMessageText(`Analysis Progress:\n${updatedProgress}`, {
                    chat_id: chatId,
                    message_id: progressMsg.message_id,
                });

                // Add delay to respect rate limits
                await delay(1000);

                // Analyze coin
                const analysis = await analyzeCoin(coin);
                const message = formatAnalysisMessage(analysis);

                // Send analysis
                await bot.sendMessage(chatId, message, { parse_mode: "HTML" });
                await delay(2000);
            } catch (error: any) {
                console.error(`Error analyzing ${coin}:`, error);

                // Update progress message to show error
                const errorProgress = COINS.map((c, index) => {
                    if (index < i) return `${c}: ✅ Done`;
                    if (index === i) return `${c}: ❌ Failed`;
                    return `${c}: ⏳ Waiting...`;
                }).join("\n");

                await bot.editMessageText(`Analysis Progress:\n${errorProgress}`, {
                    chat_id: chatId,
                    message_id: progressMsg.message_id,
                });

                await bot.sendMessage(chatId, `Failed to analyze ${coin}: ${error.message}`);
                await delay(1000);
            }
        }

        // Update final progress
        const finalProgress = COINS.map((c) => `${c}: ✅ Done`).join("\n");
        await bot.editMessageText(`Analysis Complete!\n\n${finalProgress}`, { chat_id: chatId, message_id: progressMsg.message_id });
    } catch (error) {
        console.error("Main error:", error);
        await bot.sendMessage(chatId, "Failed to complete analysis");
    }
});

// Handle /help command
bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    const status = chatStatuses.get(chatId);

    const helpMessage = `
<b>📱 Available Commands:</b>

/check - Analyze all predefined coins
/alert - Toggle automatic alerts on/off
/status - Check your alert status
/forcecheck - Force an immediate check (15min cooldown)
/help - Show this help message

<b>🪙 Supported Coins:</b>
${COINS.map((coin) => `• ${coin}`).join("\n")}

<b>⚙️ Alert Status:</b>
${status?.active ? "✅ Alerts are ON" : "❌ Alerts are OFF"}
${status?.active ? `\nNext check in: ${getTimeToNextCheck()}` : ""}
`;
    await bot.sendMessage(chatId, helpMessage, { parse_mode: "HTML" });
});

// Error handling for bot
bot.on("error", (error) => {
    console.error("Telegram Bot Error:", error);
});

// Handle polling errors
let isPollingError = false;
bot.on("polling_error", (error) => {
    if (!isPollingError) {
        console.error("Polling Error:", error);
        isPollingError = true;
    }

    // Try to restart polling after a delay
    setTimeout(() => {
        try {
            bot.stopPolling();
            setTimeout(() => {
                bot.startPolling();
                isPollingError = false;
            }, 1000);
        } catch (e) {
            console.error("Failed to restart polling:", e);
        }
    }, 5000);
});

// Ensure clean shutdown
process.on("SIGINT", () => {
    bot.stopPolling();
    process.exit();
});

process.on("SIGTERM", () => {
    bot.stopPolling();
    process.exit();
});

// Initialize bot commands only once
let commandsInitialized = false;
async function initializeBotCommands() {
    if (!commandsInitialized) {
        try {
            await bot.setMyCommands(COMMANDS);
            console.log("Bot commands have been set successfully");
            commandsInitialized = true;
        } catch (error) {
            console.error("Failed to set bot commands:", error);
        }
    }
}

// Initialize when bot is ready
bot.on("ready", () => {
    console.log("Bot is ready!");
    initializeBotCommands();
});

console.log("Bot is starting...");

// Improved message formatting
function formatAnalysisMessage(analysis: CoinAnalysis): string {
    const { symbol, currentPrice, timeframes, summary } = analysis;

    // Helper function to get emoji for condition
    const getEmoji = (condition: string) => {
        switch (condition) {
            case "above":
                return "🟢";
            case "below":
                return "🔴";
            case "none":
                return "⚪";
            default:
                return "❓";
        }
    };

    return `
<b>${symbol} Analysis</b>
💵 Price: $${currentPrice.toFixed(2)}

<b>📊 Timeframes:</b>
1D:
 • EMA: ${getEmoji(timeframes["1d"].emaCondition)} ${timeframes["1d"].emaCondition}
 • Kijun: ${getEmoji(timeframes["1d"].kijunCondition)} ${timeframes["1d"].kijunCondition}

4H:
 • EMA: ${getEmoji(timeframes["4h"].emaCondition)} ${timeframes["4h"].emaCondition}
 • Kijun: ${getEmoji(timeframes["4h"].kijunCondition)} ${timeframes["4h"].kijunCondition}

1H:
 • EMA: ${getEmoji(timeframes["1h"].emaCondition)} ${timeframes["1h"].emaCondition}
 • Kijun: ${getEmoji(timeframes["1h"].kijunCondition)} ${timeframes["1h"].kijunCondition}

<b>📈 Summary:</b>
Above All Indicators: ${summary.isAboveAll ? "✅" : "❌"}
Below All Indicators: ${summary.isBelowAll ? "✅" : "❌"}
`;
}

// Modify analyzeCoin to batch requests efficiently
async function analyzeCoin(symbol: string): Promise<CoinAnalysis> {
    const timeframeData: { [key: string]: any } = {};

    // Fetch all timeframes in parallel with rate limiting
    const klinePromises = TIMEFRAMES.map((interval) => fetchWithRetry(symbol, interval).then((klines) => (timeframeData[interval] = calculateIndicators(klines))));

    // Wait for all timeframes to complete
    await Promise.all(klinePromises);

    // Get current price (reuse 1h data for efficiency)
    const currentPrice = parseFloat((await fetchWithRetry(symbol, "1m", 1))[0].close);

    // Calculate summary
    const summary = {
        isBelowAllEma: Object.values(timeframeData).every((tf) => tf.emaCondition === "below"),
        isBelowAllKijun: Object.values(timeframeData).every((tf) => tf.kijunCondition === "below"),
        isBelowAll: Object.values(timeframeData).every((tf) => tf.emaCondition === "below" && tf.kijunCondition === "below"),
        isAboveAllEma: Object.values(timeframeData).every((tf) => tf.emaCondition === "above"),
        isAboveAllKijun: Object.values(timeframeData).every((tf) => tf.kijunCondition === "above"),
        isAboveAll: Object.values(timeframeData).every((tf) => tf.emaCondition === "above" && tf.kijunCondition === "above"),
    };

    return { symbol, currentPrice, timeframes: timeframeData, summary };
}

// Interface for alert settings
interface AlertCondition {
    isAboveAll: boolean;
    isBelowAll: boolean;
}

// Keep track of previous alerts to avoid spam
const alertedCoins = new Map<string, AlertCondition>();

// Function to check if we should alert for a coin
function shouldAlert(symbol: string, analysis: CoinAnalysis): boolean {
    const prevCondition = alertedCoins.get(symbol);
    const currentCondition = {
        isAboveAll: analysis.summary.isAboveAll,
        isBelowAll: analysis.summary.isBelowAll,
    };

    // If no previous alert or condition changed
    if (!prevCondition || prevCondition.isAboveAll !== currentCondition.isAboveAll || prevCondition.isBelowAll !== currentCondition.isBelowAll) {
        alertedCoins.set(symbol, currentCondition);
        return true;
    }

    return false;
}

// Rate limit configuration
const RATE_LIMITS = {
    CHECKS_PER_HOUR: 1,
    MAX_REQUESTS_PER_MINUTE: 1200,
    COINS_PER_BATCH: 5, // Process coins in smaller batches
    BATCH_DELAY: 10000, // 10 seconds between batches
};

// Improved periodic check function
async function runPeriodicCheck() {
    console.log(`[${new Date().toISOString()}] Starting periodic check...`);

    try {
        // Get active chats
        const activeChats = Array.from(chatStatuses.entries())
            .filter(([_, status]) => status.active)
            .map(([chatId]) => chatId);

        if (activeChats.length === 0) {
            console.log("No active chats, skipping check");
            return;
        }

        // Process coins in batches
        for (let i = 0; i < COINS.length; i += RATE_LIMITS.COINS_PER_BATCH) {
            const batch = COINS.slice(i, i + RATE_LIMITS.COINS_PER_BATCH);
            console.log(`Processing batch ${i / RATE_LIMITS.COINS_PER_BATCH + 1}:`, batch);

            // Process each coin in the batch
            for (const coin of batch) {
                try {
                    await rateLimiter.wait(); // Use the existing RateLimiter
                    const analysis = await analyzeCoin(coin);

                    if (analysis.summary.isAboveAll || analysis.summary.isBelowAll) {
                        if (shouldAlert(coin, analysis)) {
                            const message = formatAlertMessage(analysis);

                            // Send alerts with rate limiting
                            for (const chatId of activeChats) {
                                try {
                                    await rateLimiter.wait();
                                    await bot.sendMessage(chatId, message, { parse_mode: "HTML" });
                                } catch (error) {
                                    console.error(`Failed to send alert to chat ${chatId}:`, error);
                                }
                            }
                        }
                    }
                } catch (error) {
                    console.error(`Error checking ${coin}:`, error);
                }
            }

            // Add delay between batches
            if (i + RATE_LIMITS.COINS_PER_BATCH < COINS.length) {
                console.log(`Waiting ${RATE_LIMITS.BATCH_DELAY}ms before next batch...`);
                await delay(RATE_LIMITS.BATCH_DELAY);
            }
        }

        console.log(`[${new Date().toISOString()}] Periodic check completed`);
        // Update last alert time for active chats when alerts are sent
        for (const [chatId, status] of Array.from(chatStatuses.entries())) {
            if (status.active) {
                chatStatuses.set(chatId, {
                    ...status,
                    lastAlert: new Date(),
                });
            }
        }
    } catch (error) {
        console.error("Periodic check failed:", error);
    }
}

// More precise interval timing
let lastCheckTime = Date.now();
const HOUR_IN_MS = 60 * 60 * 1000;

// Replace setInterval with a more precise timer
async function scheduleNextCheck() {
    const now = Date.now();
    const timeSinceLastCheck = now - lastCheckTime;
    const waitTime = Math.max(HOUR_IN_MS - timeSinceLastCheck, 0);

    await delay(waitTime);
    await runPeriodicCheck();
    lastCheckTime = Date.now();
    scheduleNextCheck();
}

// Start the periodic checks
scheduleNextCheck();

// Add a command to force check (with cooldown)
const FORCE_CHECK_COOLDOWN = 15 * 60 * 1000; // 15 minutes
let lastForceCheck = 0;

bot.onText(/\/forcecheck/, async (msg) => {
    const now = Date.now();
    const timeSinceLastForce = now - lastForceCheck;

    if (timeSinceLastForce < FORCE_CHECK_COOLDOWN) {
        const waitMinutes = Math.ceil((FORCE_CHECK_COOLDOWN - timeSinceLastForce) / 60000);
        await bot.sendMessage(msg.chat.id, `⏳ Please wait ${waitMinutes} minutes before forcing another check.`);
        return;
    }

    await bot.sendMessage(msg.chat.id, "🔄 Starting forced check...");
    lastForceCheck = now;
    await runPeriodicCheck();
    await bot.sendMessage(msg.chat.id, "✅ Forced check completed!");
});

// Format alert message
function formatAlertMessage(analysis: CoinAnalysis): string {
    const { symbol, currentPrice, summary } = analysis;

    let condition = "";
    if (summary.isAboveAll) condition = "🚀 ABOVE all EMAs and Kijun-sen";
    if (summary.isBelowAll) condition = "📉 BELOW all EMAs and Kijun-sen";

    return `
🔔 <b>Alert: ${symbol}</b>
💵 Price: $${currentPrice.toFixed(2)}
📊 Condition: ${condition}

<b>Timeframe Analysis:</b>
1D: ${formatTimeframe(analysis.timeframes["1d"])}
4H: ${formatTimeframe(analysis.timeframes["4h"])}
1H: ${formatTimeframe(analysis.timeframes["1h"])}
`;
}

// Helper function to format timeframe info
function formatTimeframe(tf: any): string {
    return `EMA: ${tf.emaCondition}, Kijun: ${tf.kijunCondition}`;
}

// Store active chat IDs (you'll need to implement persistence)
const activeChatIds = new Set<number>();

// Command to start receiving alerts
bot.onText(/\/startalerts/, (msg) => {
    const chatId = msg.chat.id;
    activeChatIds.add(chatId);
    bot.sendMessage(chatId, "✅ You will now receive automatic alerts!");
});

// Command to stop receiving alerts
bot.onText(/\/stopalerts/, (msg) => {
    const chatId = msg.chat.id;
    activeChatIds.delete(chatId);
    bot.sendMessage(chatId, "❌ You will no longer receive automatic alerts.");
});

// Function to get active chats
async function getActiveChats(): Promise<number[]> {
    return Array.from(activeChatIds);
}

// Define available commands
const COMMANDS = [
    { command: "check", description: "Analyze all predefined coins" },
    { command: "alert", description: "Toggle automatic alerts on/off" },
    { command: "status", description: "Check your alert status" },
    { command: "forcecheck", description: "Force an immediate check (15min cooldown)" },
    { command: "help", description: "Show help message" },
];

// Store active chat IDs with timestamps
interface ChatStatus {
    active: boolean;
    lastAlert?: Date;
}

const chatStatuses = new Map<number, ChatStatus>();

// Updated alert toggle command
bot.onText(/\/alert/, async (msg) => {
    const chatId = msg.chat.id;
    const currentStatus = chatStatuses.get(chatId);

    if (currentStatus?.active) {
        chatStatuses.set(chatId, { active: false });
        await bot.sendMessage(chatId, "❌ Automatic alerts have been turned OFF");
    } else {
        chatStatuses.set(chatId, { active: true });
        await bot.sendMessage(
            chatId,
            "✅ Automatic alerts have been turned ON\n\nI'll send you alerts when coins meet the following conditions:\n" +
                "• Above all EMAs and Kijun-sen\n" +
                "• Below all EMAs and Kijun-sen\n\n" +
                "Use /status to check if alerts are working."
        );

        // Send a test alert
        await delay(1000);
        await bot.sendMessage(
            chatId,
            "🔔 <b>Test Alert</b>\n\nThis is a test alert to confirm the system is working. You'll receive real alerts during the next check cycle.\n\nNext check in: " +
                getTimeToNextCheck(),
            { parse_mode: "HTML" }
        );
    }
});

// Add status command
bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    const status = chatStatuses.get(chatId);

    let message = `📊 <b>Alert Status</b>\n\n`;
    message += `Alerts: ${status?.active ? "✅ ON" : "❌ OFF"}\n`;

    if (status?.active) {
        message += `Last Alert: ${status.lastAlert ? formatDate(status.lastAlert) : "No alerts yet"}\n`;
        message += `Next Check: ${getTimeToNextCheck()}\n\n`;
        message += `Monitoring ${COINS.length} coins for:\n`;
        message += `• Above all EMAs and Kijun-sen\n`;
        message += `• Below all EMAs and Kijun-sen`;
    }

    await bot.sendMessage(chatId, message, { parse_mode: "HTML" });
});

// Helper function to format date
function formatDate(date: Date): string {
    return date.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}

// Helper function to get time until next check
function getTimeToNextCheck(): string {
    const now = Date.now();
    const timeSinceLastCheck = now - lastCheckTime;
    const timeToNext = HOUR_IN_MS - timeSinceLastCheck;

    const minutes = Math.floor(timeToNext / 60000);
    return `${minutes} minutes`;
}

app.get("/health", (c) => c.text("OK"));

export default app;
