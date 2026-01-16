/**
 * =========================================
 * AARTI JEWELERS - GOLD PRICE SYNC
 * Updates every 60 seconds
 * SmartWebi + FizConnect
 * =========================================
 */

const axios = require("axios");
const http = require("http");

// =============== CONFIG FROM ENV ===============
const SMARTWEBI_API_KEY = process.env.SMARTWEBI_API_KEY;
const LOCATION_ID = process.env.LOCATION_ID;
const FIZCONNECT_TOKEN = process.env.FIZCONNECT_TOKEN;
const UPDATE_INTERVAL = parseInt(process.env.UPDATE_INTERVAL || "60000");

// FizConnect API
const FIZCONNECT_API = `https://stage-connect.fiztrade.com/FizServices/GetSpotPriceData/${FIZCONNECT_TOKEN}`;

// SmartWebi API
const SMARTWEBI_BASE_URL = "https://services.leadconnectorhq.com";

// Charges
const MAKING_CHARGE_PERCENTAGE = 10;
const GST_PERCENTAGE = 3;

// Headers
const smartwebiHeaders = {
  Authorization: `Bearer ${SMARTWEBI_API_KEY}`,
  "Content-Type": "application/json",
  Version: "2021-07-28",
};

// =============== STATE ===============
let lastGoldPrice = null;
let updateCount = 0;
let lastUpdate = null;

// =============== LOGGER ===============
function log(message, type = "INFO") {
  console.log(`[${new Date().toISOString()}] [${type}] ${message}`);
}

// =============== HELPERS ===============
function extractWeightAndPurity(sku) {
  if (!sku) return { purity: 24, weight: 0 };

  try {
    const parts = sku.toUpperCase().split("-");
    const purityPart = parts.find(p => p.includes("K"));
    const weightPart = parts.find(p => p.includes("G"));

    return {
      purity: purityPart ? parseInt(purityPart.replace("K", "")) : 24,
      weight: weightPart ? parseFloat(weightPart.replace("G", "")) : 0,
    };
  } catch {
    return { purity: 24, weight: 0 };
  }
}

function convertOunceToGram(pricePerOunce) {
  return pricePerOunce / 31.1035;
}

function getPurityFactor(purity) {
  return {
    24: 1.0,
    22: 0.916,
    21: 0.875,
    18: 0.75,
  }[purity] || 1.0;
}

function calculateFinalPrice(pricePerGram, weight, purity) {
  const base = pricePerGram * weight * getPurityFactor(purity);
  const making = base * (MAKING_CHARGE_PERCENTAGE / 100);
  const gst = (base + making) * (GST_PERCENTAGE / 100);
  return Math.round(base + making + gst);
}

// =============== MAIN SYNC ===============
async function syncGoldPrices() {
  try {
    log("Fetching gold price...", "INFO");

    const goldRes = await axios.get(FIZCONNECT_API, { timeout: 8000 });
    const goldPrice = goldRes.data.gold?.ask || goldRes.data.goldAsk;
    if (!goldPrice) return log("Gold price missing", "ERROR");

    lastGoldPrice = goldPrice;
    const pricePerGram = convertOunceToGram(goldPrice);

    log("Fetching products...", "INFO");

    const productsRes = await axios.get(
      `${SMARTWEBI_BASE_URL}/products/?locationId=${LOCATION_ID}`,
      { headers: smartwebiHeaders }
    );

    const products = productsRes.data.products || [];
    log(`Products found: ${products.length}`, "DEBUG");

    let updated = 0;

    for (const product of products) {
      const productId = product._id || product.id;
      if (!productId) continue;

      const priceRes = await axios.get(
        `${SMARTWEBI_BASE_URL}/products/${productId}/price?locationId=${LOCATION_ID}`,
        { headers: smartwebiHeaders }
      );

      for (const price of priceRes.data.prices || []) {
        const sku = price.sku;
        if (!sku || !sku.includes("GOLD")) continue;

        const { weight, purity } = extractWeightAndPurity(sku);
        if (!weight) continue;

        const newPrice = calculateFinalPrice(pricePerGram, weight, purity);

        const payload = {
          name: `${weight} GM ${purity}K GOLD BAR @ ${newPrice}`,
          type: "one_time",
          currency: "USD",
          amount: newPrice,
          locationId: LOCATION_ID,
        };

        log(`Updating → ${JSON.stringify(payload)}`, "DEBUG");

        await axios.put(
          `${SMARTWEBI_BASE_URL}/products/${productId}/price/${price._id}`,
          payload,
          { headers: smartwebiHeaders }
        );

        log(`✓ Updated ${sku} → ${newPrice} USD`, "SUCCESS");
        updated++;
      }
    }

    updateCount++;
    lastUpdate = new Date();

    log(
      `Sync #${updateCount} complete | Updated: ${updated} | Gold: $${goldPrice.toFixed(2)}/oz`,
      "SUCCESS"
    );
  } catch (err) {
    log(err.response?.data?.message || err.message, "ERROR");
  }
}

// =============== STARTUP ===============
log("=== AARTI JEWELERS GOLD SYNC STARTED ===", "STARTUP");
syncGoldPrices();
setInterval(syncGoldPrices, UPDATE_INTERVAL);

// =============== HEALTH SERVER ===============
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        status: "running",
        lastUpdate,
        syncCount: updateCount,
        goldPrice: lastGoldPrice,
      })
    );
  }
  res.writeHead(200);
  res.end("Gold Price Sync Running");
});

server.listen(process.env.PORT || 10000, () => {
  log("Health server running", "INFO");
});
