/**
 * =========================================
 * AARTI JEWELERS - GOLD PRICE SYNC
 * Updates every 60 seconds
 * SmartWebi + FizConnect
 * =========================================
 */
const axios = require("axios");
// =============== CONFIG FROM ENV ===============
const SMARTWEBI_API_KEY = process.env.SMARTWEBI_API_KEY;
const LOCATION_ID = process.env.LOCATION_ID;
const FIZCONNECT_TOKEN = process.env.FIZCONNECT_TOKEN;
const UPDATE_INTERVAL = parseInt(process.env.UPDATE_INTERVAL || "60000");
// FizConnect API
const FIZCONNECT_API = `https://stage-connect.fiztrade.com/FizServices/GetSpotPriceData/${FIZCONNECT_TOKEN}`;
// SmartWebi API
const SMARTWEBI_BASE_URL = "https://services.leadconnectorhq.com";
// Making charge and GST
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
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${type}]`;
  console.log(`${prefix} ${message}`);
}
// =============== HELPERS ===============
function extractWeightAndPurity(sku) {
  if (!sku) return { purity: 24, weight: 0 };
  try {
    const parts = sku.toUpperCase().split("-");
    const purityPart = parts.find((p) => p.includes("K"));
    const purity = purityPart ? parseInt(purityPart.replace("K", "")) : 24;
    const weightPart = parts.find((p) => p.includes("G"));
    const weight = weightPart ? parseFloat(weightPart.replace("G", "")) : 0;
    return { purity, weight };
  } catch (error) {
    log(`Error parsing SKU "${sku}"`, "WARN");
    return { purity: 24, weight: 0 };
  }
}
function convertOunceToGram(pricePerOunce) {
  const GRAMS_PER_OUNCE = 31.1035;
  return pricePerOunce / GRAMS_PER_OUNCE;
}
function getPurityFactor(purity) {
  const factors = {
    24: 1.0,
    22: 0.916,
    21: 0.875,
    18: 0.75,
    14: 0.583,
  };
  return factors[purity] || 1.0;
}
function calculateFinalPrice(pricePerGram, weight, purity) {
  const purityFactor = getPurityFactor(purity);
  const baseGoldCost = pricePerGram * weight * purityFactor;
  const makingCharge = baseGoldCost * (MAKING_CHARGE_PERCENTAGE / 100);
  const subtotal = baseGoldCost + makingCharge;
  const gst = subtotal * (GST_PERCENTAGE / 100);
  const finalPrice = Math.round(subtotal + gst);
  return {
    baseGoldCost: Math.round(baseGoldCost),
    makingCharge: Math.round(makingCharge),
    gst: Math.round(gst),
    finalPrice: finalPrice,
  };
}
// =============== MAIN SYNC ===============
async function syncGoldPrices() {
  try {
    // STEP 1: Get gold price
    log("Fetching gold price from FizConnect...", "INFO");
    const goldResponse = await axios.get(FIZCONNECT_API, {
      timeout: 8000,
    });
    const goldPrice = goldResponse.data.gold?.ask || goldResponse.data.goldAsk;
    if (!goldPrice) {
      log("No gold price in response", "ERROR");
      return;
    }
    // Check if price changed significantly
    if (lastGoldPrice && Math.abs(goldPrice - lastGoldPrice) > 0.01) {
      log(
        `Gold price changed: $${lastGoldPrice}/oz → $${goldPrice}/oz`,
        "PRICE_CHANGE"
      );
    }
    lastGoldPrice = goldPrice;
    const pricePerGram = convertOunceToGram(goldPrice);
    // STEP 2: Get products
    log("Fetching products...", "INFO");
    const productsResponse = await axios.get(
      `${SMARTWEBI_BASE_URL}/products/?locationId=${LOCATION_ID}`,
      { headers: smartwebiHeaders, timeout: 10000 }
    );
    const products = productsResponse.data.products || [];
    let updated = 0;
    let errors = 0;
    // STEP 3: Update each product
    for (const product of products) {
      try {
        if (!product.sku || !product.sku.toUpperCase().includes("GOLD")) {
          continue;
        }
        const { weight, purity } = extractWeightAndPurity(product.sku);
        if (!weight || weight <= 0) {
          continue;
        }
        const priceBreakdown = calculateFinalPrice(
          pricePerGram,
          weight,
          purity
        );
        const newPrice = priceBreakdown.finalPrice;
        // Update price
        await axios.put(
          `${SMARTWEBI_BASE_URL}/products/${product.id}`,
          { price: newPrice },
          { headers: smartwebiHeaders, timeout: 8000 }
        );
        updated++;
      } catch (error) {
        errors++;
      }
    }
    updateCount++;
    lastUpdate = new Date();
    log(
      `✓ Sync #${updateCount} complete | Updated: ${updated} products | Gold: $${goldPrice.toFixed(
        2
      )}/oz`,
      "SUCCESS"
    );
  } catch (error) {
    if (error.code === "ENOTFOUND") {
      log("Network error - no internet", "ERROR");
    } else if (error.response?.status === 401) {
      log("Auth failed - check API credentials", "ERROR");
    } else {
      log(`Error: ${error.message}`, "ERROR");
    }
  }
}
// =============== STARTUP ===============
log("=== AARTI JEWELERS GOLD SYNC STARTED ===", "STARTUP");
log(
  `Update interval: ${UPDATE_INTERVAL}ms (${UPDATE_INTERVAL / 1000}s)`,
  "CONFIG"
);
log(`SmartWebi Location: ${LOCATION_ID}`, "CONFIG");
log(`FizConnect Token: ${FIZCONNECT_TOKEN.substring(0, 10)}...`, "CONFIG");
// Run immediately
syncGoldPrices();

// Run every UPDATE_INTERVAL milliseconds
setInterval(syncGoldPrices, UPDATE_INTERVAL);
// Health check (for Render to keep alive)
const http = require("http");
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200);
    res.end(
      JSON.stringify({
        status: "running",
        lastUpdate: lastUpdate,
        syncCount: updateCount,
        goldPrice: lastGoldPrice,
      })
    );
  } else {
    res.writeHead(200);
    res.end(
      "Gold Price Sync Running - Updates every " + UPDATE_INTERVAL + "ms"
    );
  }
});
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  log(`Health check server running on port ${PORT}`, "INFO");
});
