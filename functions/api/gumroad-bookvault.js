// Cloudflare Pages Function: Gumroad sale ping -> BookVault print order
// Route: POST https://marcuscole.pages.dev/api/gumroad-bookvault
//
// Flow: a customer buys a PHYSICAL (paperback) product on Gumroad and picks a
// shipping speed (a Gumroad "version": Standard or Express). Gumroad collects
// payment and the shipping address, then POSTs a "ping" here. We treat that ping
// as UNTRUSTED (anyone who knows this URL can POST a form to it). The only thing
// we take from the ping is the sale_id; everything else (buyer, product, price,
// address, paid/refunded state) is re fetched from the Gumroad API with our own
// token, which an attacker cannot forge. Then we map the product to BookVault
// ISBNs, pin an allowlisted dispatch service, check the margin, and place a print
// on demand order that BookVault prints and ships straight to the buyer.
//
// SECRETS (set in Cloudflare Pages, Settings, Environment variables, NEVER in the repo):
//   BOOKVAULT_API_KEY   the bv_... key (mark as Encrypted)
//   GUMROAD_API_TOKEN   Gumroad API access token, used to fetch the authoritative sale
//   GUMROAD_SELLER_ID   our Gumroad seller id; any sale not owned by it is rejected
//   DRY_RUN             anything other than the exact string "false" = quote only via
//                       /Dispatch, no billable order. Set to "false" only when ready.
// BINDINGS (wrangler.toml):
//   ORDERS              KV namespace. "order:<sale_id>" = PodRef of a placed order
//                       (idempotency), "fail:<sale_id>" = why a sale needs manual
//                       handling (the owner's to do list). No PII is ever stored.
//
// HTTP STATUS DISCIPLINE: every handled outcome (placed, duplicate, skipped,
// needsManual) returns 200 so Gumroad's ping log stays green and does not retry
// into a duplicate order. We rely on KV, not on Gumroad's status colours, to know
// what needs attention. Only 400 (no sale_id) and 403 (wrong seller) are non 200.

// Product to book mapping. One row per paperback product on Gumroad.
// Gumroad's API reports `product_permalink` as the SHORT code (e.g. "maecjf"), not
// the custom slug in the storefront URL, so each row carries both, plus product_id
// where we have it. lookup() indexes every key so any of them resolves the book.
// printCostUSD is BookVault's print cost per unit, used for the margin floor check.
const PRODUCTS = [
  {
    title: "Lock In",
    keys: ["gofknx", "lockinpaperback"],
    lines: [{ isbn: "9656946000010", qty: 1 }],
    printCostUSD: 2.87,
  },
  {
    title: "Your Phone Owns You",
    keys: ["jmaasv", "yourphonepaperback"],
    lines: [{ isbn: "9656946000034", qty: 1 }],
    printCostUSD: 2.87,
  },
  {
    title: "Marcus Cole Bundle",
    keys: ["maecjf", "marcuspaperbackbundle", "1UKJeFBLB0BJ-4KlPWMMZQ=="],
    lines: [{ isbn: "9656946000041", qty: 1 }],
    printCostUSD: 5.45,
  },
];

// Flat index: every key (short code, slug alias, product_id) -> book row.
// Keys are matched case sensitively for product_id (base64, case matters) and
// lower cased for permalinks, so we index both forms.
const PRODUCT_INDEX = (() => {
  const idx = new Map();
  for (const book of PRODUCTS) for (const k of book.keys) { idx.set(k, book); idx.set(k.toLowerCase(), book); }
  return idx;
})();

function lookupBook(sale) {
  const candidates = [sale.product_id, sale.product_permalink, sale.permalink].filter(Boolean).map(String);
  for (const c of candidates) {
    const hit = PRODUCT_INDEX.get(c) || PRODUCT_INDEX.get(c.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

// Shipping tier -> BookVault dispatch. Verified against live /Dispatch (US):
//   standard = ServiceLevel "Cheapest" = USPS Media Mail, ServID 126 (~$7.42, 3-8 days, tracked)
//   express  = ServiceLevel "Quickest" = UPS Ground,      ServID 129 (~$14.60, 1-5 days, tracked)
// EXPECTED_SERVID is the allowlist: we only ever pin a known service id. If BookVault
// reshuffles ids, CAP_USD is the fallback: cheapest service under the cap for that
// tier, otherwise the order is parked for manual review rather than shipped on an
// unknown (possibly very expensive) carrier.
const TIER = {
  standard: { serviceLevel: "Cheapest", expectedServID: 126, capUSD: 9.0 },
  express:  { serviceLevel: "Quickest", expectedServID: 129, capUSD: 16.0 },
};

// Countries we currently fulfil. /Dispatch quotes are only validated for these.
// To open a new market: verify its /Dispatch services live, add the ISO2 here, and
// (if its service ids differ) extend TIER with a per country override.
const SUPPORTED_COUNTRIES = new Set(["US"]);

// Minimum profit we accept on a single sale after Gumroad fees, print cost and
// postage. Below this the sale is parked for manual review instead of silently
// shipping at a loss (e.g. a discount code stacked with express shipping).
const MARGIN_FLOOR_USD = 1.5;

const BV = "https://api.bookvault.app/v3";
const GUMROAD = "https://api.gumroad.com/v2";

export async function onRequestPost(context) {
  const { request, env } = context;
  const log = (...a) => console.log("[bv]", ...a);

  // saleId is hoisted so the catch block can tag the failure record with it.
  let saleId = "";
  try {
    // ---- 1. parse the ping. We only need sale_id (and a couple of fast reject hints)
    const p = await parsePing(request);
    if (!p) return json({ ok: false, error: "bad body" }, 400);

    saleId = String(p.sale_id || "").trim();
    if (!saleId) return json({ ok: false, error: "no sale_id" }, 400);
    // Gumroad's "send test ping" button. Nothing to fulfil, and not a failure.
    if (String(p.test) === "true") return json({ ok: true, skipped: "test" });
    // Fast reject: a ping that names a different seller is not ours, and we do not
    // want to burn a Gumroad API call on it. (The real check is on the API sale below.)
    if (p.seller_id && env.GUMROAD_SELLER_ID && p.seller_id !== env.GUMROAD_SELLER_ID) {
      log("seller mismatch on ping", saleId);
      return json({ ok: false, error: "seller mismatch" }, 403);
    }

    // ---- 2. config guard. Missing config is an ops problem, not a Gumroad problem,
    // so we record it and answer 200 (the sale is still real and needs a human).
    if (!env.GUMROAD_API_TOKEN || !env.GUMROAD_SELLER_ID || !env.BOOKVAULT_API_KEY) {
      log("missing config", saleId);
      await recordFail(env, saleId, "config");
      return json({ ok: false, needsManual: true, reason: "config" });
    }

    // ---- 3. idempotency. Gumroad retries pings and a human may resend one; a sale
    // that already produced a PodRef must never print twice.
    const existing = await kvGet(env, "order:" + saleId);
    if (existing) {
      log("duplicate ping", saleId, "pod", existing);
      return json({ ok: true, duplicate: true });
    }

    // ---- 4. fetch the authoritative sale from Gumroad with OUR token.
    // Everything after this point uses `sale`, never the ping.
    const sale = await fetchSale(env, saleId);
    if (!sale) {
      log("sale lookup failed", saleId);
      await recordFail(env, saleId, "sale lookup");
      return json({ ok: false, needsManual: true, reason: "sale lookup" });
    }

    // ---- 5. verify ownership and payment state.
    // Seller mismatch on the API record is a hard reject: someone fed us a sale_id
    // from another shop. Unpaid/refunded/disputed are legitimate skips, not failures.
    if (sale.seller_id !== env.GUMROAD_SELLER_ID) {
      log("seller mismatch on sale", saleId);
      return json({ ok: false, error: "seller mismatch" }, 403);
    }
    if (sale.paid !== true) {
      log("skip unpaid", saleId);
      return json({ ok: true, skipped: "unpaid" });
    }
    if (sale.refunded || sale.partially_refunded || sale.chargedback || sale.disputed || sale.access_revoked) {
      log("skip refunded/disputed", saleId);
      return json({ ok: true, skipped: "refunded" });
    }

    // ---- 6. map the product to a book
    const book = lookupBook(sale);
    if (!book) {
      // A paid sale we cannot fulfil automatically. Could be a new product that is
      // not mapped yet, so this must reach the owner rather than be ignored.
      log("no mapping", saleId, sale.product_permalink);
      await recordFail(env, saleId, "no mapping", {
        product_permalink: sale.product_permalink || null,
        product_id: sale.product_id || null,
      });
      return json({ ok: false, needsManual: true, reason: "no mapping" });
    }

    // ---- 7. shipping tier from the chosen Gumroad version
    const tier = detectTier(sale);
    const tierCfg = TIER[tier];
    // Raw tier evidence (no PII) so the first real versioned sale self confirms
    // detection from the Cloudflare log, without a paid test purchase.
    log("tier evidence", saleId, "vaq=", JSON.stringify(str(sale.variants_and_quantity)), "variants=", JSON.stringify(sale.variants || null), "->", tier);
    const qty = Math.max(1, parseInt(sale.quantity, 10) || 1);

    // ---- 8. destination country (already ISO2 on the API sale)
    const country = String(sale.country_iso2 || "").toUpperCase();
    if (!SUPPORTED_COUNTRIES.has(country)) {
      log("intl not supported", saleId, country);
      await recordFail(env, saleId, "intl not supported", { country: country || null, tier, product_permalink: sale.product_permalink || null });
      return json({ ok: false, needsManual: true, reason: "intl not supported" });
    }

    // ---- 9. order lines (bundle rows can list several ISBNs; each scales by sale qty)
    const orderLines = book.lines.map((l) => ({ ISBN: l.isbn, Quantity: (l.qty || 1) * qty }));

    const auth = { Authorization: "basic " + env.BOOKVAULT_API_KEY, "Content-Type": "application/json" };

    // ---- 10. quote via /Dispatch. We need two things back: the resolved Country
    // OBJECT (the /Order endpoint rejects a bare "US" string) and the live service
    // list so we can pin an exact ServID.
    const quote = await bvDispatch(auth, { OrderLines: orderLines, CountryCode: country, ServiceLevel: tierCfg.serviceLevel, Currency: "USD" });
    if (!quote.ok) {
      log("dispatch failed", saleId, quote.status);
      await recordFail(env, saleId, "dispatch", { status: quote.status, tier, product_permalink: sale.product_permalink || null });
      return json({ ok: false, needsManual: true, reason: "dispatch" });
    }

    // ---- 11. choose the service: allowlisted id first, capped cheapest as fallback,
    // otherwise park it. We NEVER send an unpinned service to /Order.
    const service = pickService(quote.services, tierCfg);
    if (!service) {
      log("no acceptable service", saleId, tier);
      await recordFail(env, saleId, "no acceptable service", {
        tier, product_permalink: sale.product_permalink || null,
        offered: quote.services.map((s) => ({ ServID: s.ServID, DelTotal: s.DelTotal })),
      });
      return json({ ok: false, needsManual: true, reason: "no acceptable service" });
    }
    const shipTotal = Number(service.DelTotal) || 0;

    // ---- 12. ship to address, from the API sale only (flat Gumroad fields)
    const address = {
      Addressee: str(sale.full_name),
      Address1: str(sale.street_address),
      Address2: "",
      Town: str(sale.city),
      County: str(sale.state),
      Postcode: str(sale.zip_code),
      Country: quote.country,
      Email: str(sale.email || sale.purchase_email),
      // UPS (Express) requires a recipient phone; Gumroad/Apple Pay often gives none,
      // so fall back to a configured business number (env FALLBACK_PHONE).
      TelNumber: str(sale.phone || sale.phone_number) || str(env.FALLBACK_PHONE),
    };
    if (!address.Addressee || !address.Address1 || !address.Town || !address.Postcode || !address.Country) {
      // Gumroad sometimes returns a sale before the address is attached, or the
      // product was not flagged as physical. A human has to chase the buyer.
      log("blank address", saleId);
      await recordFail(env, saleId, "blank address", { tier, product_permalink: sale.product_permalink || null });
      return json({ ok: false, needsManual: true, reason: "blank address" });
    }

    // ---- 13. margin floor. price and gumroad_fee are in cents on the API sale.
    const net = (toNum(sale.price) - toNum(sale.gumroad_fee)) / 100;
    const cost = round2(book.printCostUSD * qty + shipTotal);
    const margin = round2(net - cost);
    if (margin < MARGIN_FLOOR_USD) {
      log("margin below floor", saleId, "net", net, "cost", cost);
      await recordFail(env, saleId, "margin below floor", { net: round2(net), cost, tier, product_permalink: sale.product_permalink || null });
      return json({ ok: false, needsManual: true, reason: "margin below floor" });
    }

    // ---- 14. the order
    const order = {
      CustRef: saleId,
      DocRef: saleId,
      OrderMethod: "API",
      ProductionLevel: "Standard",
      DispatchRequest: { RequestedService: "Specified", RequestedServID: [service.ServID] },
      Address: address,
      OrderLines: orderLines,
    };

    // ---- 15. dry run: everything above ran for real (quote, validation, margin),
    // only the billable call is skipped. The response is redacted: never echo the
    // buyer's name, email or address back over HTTP.
    const dryRun = String(env.DRY_RUN ?? "true") !== "false";
    if (dryRun) {
      log("DRY_RUN", saleId, book.title, tier, "servID", service.ServID, "ship", shipTotal);
      return json({
        ok: true, dryRun: true, tier,
        requestedServID: service.ServID, shipTotal, marginOK: true,
        wouldOrderRedacted: { OrderLines: orderLines, country: quote.country.ISO_Code, hasAddress: true },
      });
    }

    // ---- 16. live: place the print order (BILLABLE, prints and ships)
    const r = await fetch(BV + "/Order", { method: "POST", headers: auth, body: JSON.stringify(order) });
    const raw = await r.text();
    let body = {};
    try { body = JSON.parse(raw); } catch (e) {}
    if (!r.ok || body.CriticalError) {
      log("ORDER FAILED", saleId, r.status, raw.slice(0, 500));
      await recordFail(env, saleId, "order failed", {
        status: r.status, tier, product_permalink: sale.product_permalink || null,
        servID: service.ServID,
        bvError: raw.slice(0, 600),
        sentDispatch: order.DispatchRequest,
        sentLines: order.OrderLines,
      });
      return json({ ok: false, needsManual: true, reason: "order failed" });
    }

    // 200 with no CriticalError but also no PodRef: BookVault accepted the call but
    // did not confirm an order id. Block retries (write order:) AND flag for a human
    // (write fail:) so someone verifies in the BookVault dashboard rather than
    // assuming it printed.
    if (body.PodRef == null) {
      await kvPut(env, "order:" + saleId, "unconfirmed");
      await recordFail(env, saleId, "order unconfirmed", { tier, product_permalink: sale.product_permalink || null });
      log("ORDER UNCONFIRMED (no PodRef)", saleId);
      return json({ ok: true, unconfirmed: true, tier });
    }

    // Record the PodRef BEFORE answering so a retried ping can never double print.
    // If this put fails the order still exists; kvPut swallows the error, so log loudly.
    const podRef = String(body.PodRef);
    const saved = await kvPut(env, "order:" + saleId, podRef);
    if (!saved) log("WARNING order placed but KV write failed", saleId, "pod", podRef);
    log("ORDER PLACED", saleId, book.title, tier, "pod", podRef);
    return json({ ok: true, podRef: body.PodRef, tier });
  } catch (e) {
    // Anything unexpected: park the sale for a human and keep Gumroad happy.
    console.log("[bv] exception", saleId, String(e && e.message ? e.message : e));
    if (saleId) await recordFail(env, saleId, "exception", { message: String(e && e.message ? e.message : e).slice(0, 200) });
    return json({ ok: false, error: "internal" });
  }
}

// ---------------------------------------------------------------- helpers

// Gumroad pings are form encoded. Fall back to parsing the raw text as a query
// string in case the Content-Type header is off (formData() throws then).
async function parsePing(request) {
  try {
    const form = await request.formData();
    return Object.fromEntries(form.entries());
  } catch (e) {
    try {
      const text = await request.text();
      return Object.fromEntries(new URLSearchParams(text).entries());
    } catch (e2) {
      return null;
    }
  }
}

// Fetch one sale by id. The single sale endpoint answers {success, sale:{...}};
// we also accept a `sales` array in case the wrapper differs, and treat any non
// success as "not found" so the caller parks it for review.
async function fetchSale(env, saleId) {
  const url = GUMROAD + "/sales/" + encodeURIComponent(saleId) + "?access_token=" + encodeURIComponent(env.GUMROAD_API_TOKEN);
  let r;
  try {
    r = await fetch(url, { headers: { Accept: "application/json" } });
  } catch (e) {
    return null;
  }
  if (!r.ok) return null;
  const body = await r.json().catch(() => null);
  if (!body || body.success === false) return null;
  const sale = body.sale || (Array.isArray(body.sales) ? body.sales[0] : null);
  if (!sale || typeof sale !== "object") return null;
  // Belt and braces: the record we got back must be the sale we asked for.
  if (sale.id && String(sale.id) !== saleId) return null;
  return sale;
}

// Decide Standard vs Express from Gumroad's human readable variant string, e.g.
//   "Express Shipping (2 to 5 business days)"
//   "(1x Standard Shipping (5 to 8 business days))"
//   ""   (product with a single version, or none)
// Only clearly express wording upgrades; anything else, including blank, is standard.
// Gumroad carries the chosen version in two places: the human readable
// `variants_and_quantity` string AND a `variants` object keyed by category
// (e.g. {"Version":"Express Shipping (2 to 5 business days)"}). We scan both, so
// a miss would require both to be blank or renamed.
function detectTier(sale) {
  const hay = String(sale.variants_and_quantity || "") + " " + JSON.stringify(sale.variants || "");
  return /express|quick|ups|priority|fast/i.test(hay) ? "express" : "standard";
}

// POST /Dispatch and normalise the reply. Returns {ok, status, country, services}.
async function bvDispatch(auth, payload) {
  let r;
  try {
    r = await fetch(BV + "/Dispatch", { method: "POST", headers: auth, body: JSON.stringify(payload) });
  } catch (e) {
    return { ok: false, status: 0 };
  }
  const body = await r.json().catch(() => null);
  if (!r.ok || !body || !body.Country || !Array.isArray(body.Services) || body.Services.length === 0) {
    return { ok: false, status: r.status };
  }
  return { ok: true, status: r.status, country: body.Country, services: body.Services };
}

// Allowlist + price cap. Prefer the exact expected ServID; if BookVault stopped
// offering it, take the cheapest service under the tier cap; otherwise null.
function pickService(services, tierCfg) {
  const exact = services.find((s) => Number(s.ServID) === tierCfg.expectedServID);
  if (exact) return exact;
  const under = services
    .filter((s) => Number.isFinite(Number(s.DelTotal)) && Number(s.DelTotal) <= tierCfg.capUSD)
    .sort((a, b) => Number(a.DelTotal) - Number(b.DelTotal));
  return under[0] || null;
}

// The owner's dashboard: "fail:<sale_id>" -> why it needs a human. Best effort and
// PII free by construction (callers only pass reason/tier/status/product/net/cost).
async function recordFail(env, saleId, reason, extra) {
  try {
    if (!env || !env.ORDERS) return;
    await env.ORDERS.put("fail:" + saleId, JSON.stringify({ reason, at: new Date().toISOString(), ...(extra || {}) }));
  } catch (e) {
    console.log("[bv] recordFail failed", saleId, reason);
  }
}

async function kvGet(env, key) {
  try { return env.ORDERS ? await env.ORDERS.get(key) : null; } catch (e) { return null; }
}

async function kvPut(env, key, value) {
  try { if (!env.ORDERS) return false; await env.ORDERS.put(key, value); return true; } catch (e) { return false; }
}

function str(v) { return v == null ? "" : String(v).trim(); }
function toNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function round2(n) { return Math.round(n * 100) / 100; }

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
