// Cloudflare Pages Function: Gumroad sale ping to Lulu print job
// Route: POST https://marcuscole.pages.dev/api/gumroad-lulu
//        GET  https://marcuscole.pages.dev/api/gumroad-lulu?selftest=<token>  (operator only, see bottom)
//
// Flow: a customer buys a PHYSICAL (paperback) product on Gumroad and picks a
// shipping speed (a Gumroad "version": Standard or Express). Gumroad collects
// payment and the shipping address, then POSTs a "ping" here. We treat that ping
// as UNTRUSTED (anyone who knows this URL can POST a form to it). The only thing
// we take from the ping is the sale_id; everything else (buyer, product, price,
// address, paid/refunded state) is re fetched from the Gumroad API with our own
// token, which an attacker cannot forge. Then we map the product to Lulu print
// specs (pod_package_id, page count, cover and interior PDF URLs), price the job
// with Lulu's cost calculator, check the margin, and create a Lulu print job that
// Lulu prints and ships straight to the buyer.
//
// PAYMENT MODEL (why the live path is safe to switch on): a Lulu print job is
// created UNPAID. Lulu only prints and charges once the account has a card on
// file and the job moves to PAYMENT_IN_PROGRESS. Creating a job with no card on
// file costs nothing; it just sits in UNPAID until paid or CANCELED.
//
// SECRETS (set in Cloudflare Pages, Settings, Environment variables, NEVER in the repo):
//   LULU_CLIENT_KEY      Lulu API client key (mark as Encrypted)
//   LULU_CLIENT_SECRET   Lulu API client secret (mark as Encrypted)
//   LULU_ENV             "production" = https://api.lulu.com, anything else = the
//                        sandbox at https://api.sandbox.lulu.com (sandbox needs its
//                        own sandbox client key and secret, they are not shared)
//   LULU_CONTACT_EMAIL   optional, the owner email Lulu contacts about a job
//   LULU_URL_LOCKIN_COVER, LULU_URL_LOCKIN_INTERIOR
//   LULU_URL_YOURPHONE_COVER, LULU_URL_YOURPHONE_INTERIOR
//                        public URLs of the print ready PDFs Lulu downloads. Kept in
//                        env so hosting can move without a code edit.
//   GUMROAD_API_TOKEN    Gumroad API access token, used to fetch the authoritative sale
//   GUMROAD_SELLER_ID    our Gumroad seller id; any sale not owned by it is rejected
//   FALLBACK_PHONE       business phone used when the buyer gave none (Lulu requires one)
//   DRY_RUN              anything other than the exact string "false" = auth, cost
//                        calc and payload build only, no print job. Set to "false"
//                        only when ready.
// BINDINGS (wrangler.toml):
//   ORDERS               KV namespace. "order:<sale_id>" = Lulu print job id of a
//                        created job (idempotency), "fail:<sale_id>" = why a sale
//                        needs manual handling (the owner's to do list). No PII is
//                        ever stored.
//
// HTTP STATUS DISCIPLINE: every handled outcome (created, duplicate, skipped,
// needsManual) returns 200 so Gumroad's ping log stays green and does not retry
// into a duplicate job. We rely on KV, not on Gumroad's status colours, to know
// what needs attention. Only 400 (no sale_id) and 403 (wrong seller, bad selftest
// token) are non 200.

// Physical book specs. One row per printable title. pod_package_id encodes trim,
// colour, paper and binding in Lulu's format; page_count must match the interior
// PDF exactly or Lulu rejects the job. printCostUSD is Lulu's list print cost per
// unit at these specs, used for the margin floor check. coverEnv/interiorEnv name
// the env vars that hold the public PDF URLs.
const BOOKS = {
  lockin: {
    title: "Lock In",
    pod_package_id: "0550X0850.BW.STD.PB.060UW444.MXX",
    page_count: 102,
    printCostUSD: 4.54,
    coverEnv: "LULU_URL_LOCKIN_COVER",
    interiorEnv: "LULU_URL_LOCKIN_INTERIOR",
  },
  yourphone: {
    title: "Your Phone Owns You",
    pod_package_id: "0600X0900.BW.STD.PB.060UW444.MXX",
    page_count: 122,
    printCostUSD: 5.04,
    coverEnv: "LULU_URL_YOURPHONE_COVER",
    interiorEnv: "LULU_URL_YOURPHONE_INTERIOR",
  },
};

// Product to book mapping. One row per paperback product on Gumroad.
// Gumroad's API reports `product_permalink` as the SHORT code (e.g. "maecjf"), not
// the custom slug in the storefront URL, so each row carries both, plus product_id
// where we have it. lookup() indexes every key so any of them resolves the row.
// A bundle row lists several line items; each is one BOOKS entry with its own qty.
const PRODUCTS = [
  {
    title: "Lock In",
    keys: ["gofknx", "lockinpaperback"],
    lines: [{ book: "lockin", qty: 1 }],
  },
  {
    title: "Your Phone Owns You",
    keys: ["jmaasv", "yourphonepaperback"],
    lines: [{ book: "yourphone", qty: 1 }],
  },
  {
    title: "Marcus Cole Bundle",
    keys: ["maecjf", "marcuspaperbackbundle", "1UKJeFBLB0BJ-4KlPWMMZQ=="],
    lines: [{ book: "lockin", qty: 1 }, { book: "yourphone", qty: 1 }],
  },
];

// Flat index: every key (short code, slug alias, product_id) to product row.
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

// Shipping tier to Lulu shipping_level. Lulu's levels are MAIL, PRIORITY_MAIL,
// GROUND_HD, GROUND_BUS, GROUND, EXPEDITED, EXPRESS. For our packages to a US
// address Lulu does NOT offer plain GROUND, EXPEDITED ships ~22 USD and EXPRESS
// ~38 USD (both eat the margin at our prices), so:
//   standard = MAIL       (Media Mail, ~6 USD, 5 to 8 days, cheapest tracked)
//   express  = GROUND_HD   (ground home delivery, ~14.57 USD, 3 to 6 days, keeps
//                           the current Gumroad Express price profitable)
// These are the only two values this function will ever send.
const TIER = {
  standard: { shippingLevel: "MAIL" },
  express:  { shippingLevel: "GROUND_HD" },
};

// Countries we currently fulfil. Cost and shipping levels are only validated for
// these. To open a new market: check the levels Lulu offers there via the cost
// calculator, add the ISO2 here, and (if levels differ) extend TIER per country.
const SUPPORTED_COUNTRIES = new Set(["US"]);

// Minimum profit we accept on a single sale after Gumroad fees, print cost and
// postage. Below this the sale is parked for manual review instead of silently
// shipping at a loss (e.g. a discount code stacked with express shipping).
const MARGIN_FLOOR_USD = 1.5;

// Fixed token for the operator self test (GET path at the bottom of this file).
// It only gates a free create then cancel round trip; it cannot read sales or KV.
const SELFTEST_TOKEN = "b7f3a1c92e6d4f08";

const GUMROAD = "https://api.gumroad.com/v2";

// Lulu base URL from env. Production and sandbox are separate systems with
// separate credentials; the sandbox never prints anything.
function luluBase(env) {
  return String(env.LULU_ENV || "").toLowerCase() === "production" ? "https://api.lulu.com" : "https://api.sandbox.lulu.com";
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const log = (...a) => console.log("[lulu]", ...a);

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
    if (!env.GUMROAD_API_TOKEN || !env.GUMROAD_SELLER_ID || !env.LULU_CLIENT_KEY || !env.LULU_CLIENT_SECRET) {
      log("missing config", saleId);
      await recordFail(env, saleId, "config");
      return json({ ok: false, needsManual: true, reason: "config" });
    }

    // ---- 3. idempotency. Gumroad retries pings and a human may resend one; a sale
    // that already produced a Lulu job id must never print twice.
    const existing = await kvGet(env, "order:" + saleId);
    if (existing) {
      log("duplicate ping", saleId, "job", existing);
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
    const shippingLevel = TIER[tier].shippingLevel;
    // Raw tier evidence (no PII) so the first real versioned sale self confirms
    // detection from the Cloudflare log, without a paid test purchase.
    log("tier evidence", saleId, "vaq=", JSON.stringify(str(sale.variants_and_quantity)), "variants=", JSON.stringify(sale.variants || null), "to", tier, shippingLevel);
    const qty = Math.max(1, parseInt(sale.quantity, 10) || 1);

    // ---- 8. destination country (already ISO2 on the API sale)
    const country = String(sale.country_iso2 || "").toUpperCase();
    if (!SUPPORTED_COUNTRIES.has(country)) {
      log("intl not supported", saleId, country);
      await recordFail(env, saleId, "intl not supported", { country: country || null, tier, product_permalink: sale.product_permalink || null });
      return json({ ok: false, needsManual: true, reason: "intl not supported" });
    }

    // ---- 9. line items (bundle rows list several books; each scales by sale qty).
    // Every line needs its cover and interior PDF URL from env. We never send a job
    // with a missing file: Lulu would reject it, or worse, print the wrong thing.
    const built = buildLineItems(env, book, qty);
    if (!built.ok) {
      log("missing source url", saleId, built.missing);
      await recordFail(env, saleId, "missing source url", { missing: built.missing, tier, product_permalink: sale.product_permalink || null });
      return json({ ok: false, needsManual: true, reason: "missing source url" });
    }
    const lineItems = built.lineItems;
    const staticPrintCost = built.printCostUSD;

    // ---- 10. ship to address, from the API sale only (flat Gumroad fields).
    // Lulu requires a phone number on every shipping address; Gumroad/Apple Pay
    // often gives none, so fall back to a configured business number.
    const address = {
      name: str(sale.full_name),
      street1: str(sale.street_address),
      city: str(sale.city),
      state_code: str(sale.state),
      postcode: str(sale.zip_code),
      country_code: country,
      phone_number: str(sale.phone || sale.phone_number) || str(env.FALLBACK_PHONE),
      email: str(sale.email || sale.purchase_email),
    };
    if (!address.name || !address.street1 || !address.city || !address.postcode) {
      // Gumroad sometimes returns a sale before the address is attached, or the
      // product was not flagged as physical. A human has to chase the buyer.
      log("blank address", saleId);
      await recordFail(env, saleId, "blank address", { tier, product_permalink: sale.product_permalink || null });
      return json({ ok: false, needsManual: true, reason: "blank address" });
    }
    if (!address.phone_number) {
      log("no phone and no FALLBACK_PHONE", saleId);
      await recordFail(env, saleId, "no phone", { tier, product_permalink: sale.product_permalink || null });
      return json({ ok: false, needsManual: true, reason: "no phone" });
    }

    // ---- 11. Lulu auth. The token lives only in this request; never logged.
    const base = luluBase(env);
    const tok = await luluToken(env, base);
    if (!tok.ok) {
      log("lulu auth failed", saleId, tok.status);
      await recordFail(env, saleId, "lulu auth", { status: tok.status, tier, product_permalink: sale.product_permalink || null });
      return json({ ok: false, needsManual: true, reason: "lulu auth" });
    }
    const token = tok.token;

    // ---- 12. cost calculation for the margin floor. This is the only way to learn
    // the real shipping charge for this address and level. If the calculator is
    // down we do NOT block the sale: the static print cost is known and the floor
    // is a guard against surprises, not a hard dependency. We log the skip so it is
    // visible, and note it in the response.
    const calc = await luluFetch(base, token, "/print-job-cost-calculations/", "POST", {
      line_items: lineItems.map((li) => ({ page_count: li.page_count, pod_package_id: li.pod_package_id, quantity: li.quantity })),
      shipping_address: address,
      shipping_option: shippingLevel,
    });
    let shipTotal = null;
    let luluPrintTotal = null;
    let marginChecked = false;
    // Only trust a shipping figure that is actually present and numeric. A body with
    // no shipping_cost must not read as "free postage" and wave the margin through.
    const rawShip = calc.ok && calc.body && calc.body.shipping_cost ? Number(calc.body.shipping_cost.total_cost_incl_tax) : NaN;
    if (Number.isFinite(rawShip)) {
      shipTotal = round2(rawShip);
      if (Array.isArray(calc.body.line_item_costs)) {
        luluPrintTotal = round2(calc.body.line_item_costs.reduce((s, c) => s + toNum(c.total_cost_incl_tax), 0));
      }
    } else {
      log("cost calc unavailable, margin check skipped", saleId, calc.status, (calc.raw || "").slice(0, 500));
    }

    // ---- 13. margin floor. price and gumroad_fee are in cents on the API sale.
    // Cost = our static print cost table plus Lulu's live shipping quote. Lulu's own
    // line total is logged next to it so a drift in the static table shows up.
    const net = (toNum(sale.price) - toNum(sale.gumroad_fee)) / 100;
    let cost = null;
    let margin = null;
    if (shipTotal !== null) {
      marginChecked = true;
      cost = round2(staticPrintCost + shipTotal);
      margin = round2(net - cost);
      log("margin", saleId, "net", round2(net), "print", staticPrintCost, "luluPrint", luluPrintTotal, "ship", shipTotal, "margin", margin);
      if (margin < MARGIN_FLOOR_USD) {
        log("margin below floor", saleId, "net", net, "cost", cost);
        await recordFail(env, saleId, "margin below floor", { net: round2(net), cost, shipTotal, tier, shippingLevel, product_permalink: sale.product_permalink || null });
        return json({ ok: false, needsManual: true, reason: "margin below floor" });
      }
    }

    // ---- 14. the print job. external_id is our sale id so the Lulu dashboard and
    // KV agree on which sale a job belongs to (Lulu treats it as a reference, our
    // KV write is the real idempotency lock).
    const job = {
      external_id: saleId,
      contact_email: str(env.LULU_CONTACT_EMAIL) || "golpo.yta@protonmail.com",
      line_items: lineItems,
      shipping_level: shippingLevel,
      shipping_address: address,
    };

    // ---- 15. dry run: everything above ran for real (auth, cost calc, validation,
    // margin), only the job creation is skipped. The response is redacted: never
    // echo the buyer's name, email, phone or address back over HTTP.
    const dryRun = String(env.DRY_RUN ?? "true") !== "false";
    if (dryRun) {
      log("DRY_RUN", saleId, book.title, tier, shippingLevel, "ship", shipTotal, "marginChecked", marginChecked);
      return json({
        ok: true, dryRun: true, tier, shippingLevel,
        shipTotal, luluPrintTotal, marginChecked, marginOK: marginChecked ? true : null,
        would: {
          external_id: saleId,
          line_items: lineItems.map((li) => ({ title: li.title, pod_package_id: li.pod_package_id, page_count: li.page_count, quantity: li.quantity })),
          shipping_level: shippingLevel,
          country: country,
          hasAddress: true,
        },
      });
    }

    // ---- 16. live: create the print job. Created UNPAID; Lulu charges the card on
    // file and prints once payment settles, so this call by itself is not billable.
    const r = await luluFetch(base, token, "/print-jobs/", "POST", job);
    if (!r.ok) {
      log("JOB FAILED", saleId, r.status, (r.raw || "").slice(0, 500));
      await recordFail(env, saleId, "job failed", {
        status: r.status, tier, shippingLevel, product_permalink: sale.product_permalink || null,
        luluError: (r.raw || "").slice(0, 600),
        sentLines: lineItems.map((li) => ({ pod_package_id: li.pod_package_id, page_count: li.page_count, quantity: li.quantity })),
      });
      return json({ ok: false, needsManual: true, reason: "job failed" });
    }

    // 2xx but no id: Lulu accepted the call but did not confirm a job. Block retries
    // (write order:) AND flag for a human (write fail:) so someone verifies in the
    // Lulu dashboard rather than assuming it printed.
    const body = r.body || {};
    if (body.id == null) {
      await kvPut(env, "order:" + saleId, "unconfirmed");
      await recordFail(env, saleId, "job unconfirmed", { status: r.status, tier, shippingLevel, product_permalink: sale.product_permalink || null });
      log("JOB UNCONFIRMED (no id)", saleId);
      return json({ ok: true, unconfirmed: true, tier, shippingLevel });
    }

    // Record the job id BEFORE answering so a retried ping can never double print.
    // If this put fails the job still exists; kvPut swallows the error, so log loudly.
    const jobId = String(body.id);
    const status = body.status && body.status.name ? String(body.status.name) : null;
    const saved = await kvPut(env, "order:" + saleId, jobId);
    if (!saved) log("WARNING job created but KV write failed", saleId, "job", jobId);
    log("JOB CREATED", saleId, book.title, tier, shippingLevel, "job", jobId, "status", status);
    return json({ ok: true, jobId, status, tier, shippingLevel });
  } catch (e) {
    // Anything unexpected: park the sale for a human and keep Gumroad happy.
    console.log("[lulu] exception", saleId, String(e && e.message ? e.message : e));
    if (saleId) await recordFail(env, saleId, "exception", { message: String(e && e.message ? e.message : e).slice(0, 200) });
    return json({ ok: false, error: "internal" });
  }
}

// ---------------------------------------------------------------- self test (GET)
//
// Operator only. Proves the whole Lulu create path for FREE: creates a real Lock In
// print job to a fixed public test address using the env source URLs, then cancels
// it straight away (an UNPAID job that is CANCELED is never charged or printed).
// Returns the job id, the status after create and after cancel, and any Lulu
// validation errors, so a broken PDF URL or wrong page count surfaces here rather
// than on a customer order. Touches no KV and reads no Gumroad data.
//
// URL: GET /api/gumroad-lulu?selftest=b7f3a1c92e6d4f08
// If cancel fails the response says so loudly with the id: cancel it by hand in the
// Lulu dashboard before it ever gets paid.
export async function onRequestGet(context) {
  const { request, env } = context;
  const log = (...a) => console.log("[lulu selftest]", ...a);

  let url;
  try { url = new URL(request.url); } catch (e) { return json({ ok: false, error: "bad url" }, 400); }
  if (url.searchParams.get("selftest") !== SELFTEST_TOKEN) {
    return json({ ok: false, error: "forbidden" }, 403);
  }

  const result = { ok: false, env: luluBase(env), steps: [] };
  try {
    if (!env.LULU_CLIENT_KEY || !env.LULU_CLIENT_SECRET) {
      return json({ ...result, error: "missing LULU_CLIENT_KEY or LULU_CLIENT_SECRET" });
    }

    // Which product to prove: ?book=<index into PRODUCTS> (default 0 = Lock In).
    // qty 1, from the same env URLs the live path uses.
    const product = PRODUCTS[Number(url.searchParams.get("book")) || 0] || PRODUCTS[0];
    result.product = product.title;
    const built = buildLineItems(env, product, 1);
    if (!built.ok) return json({ ...result, error: "missing source url", missing: built.missing });

    // A fixed public address (the Library of Congress). Not a person, no PII.
    const address = {
      name: "Selftest Do Not Ship",
      street1: "101 Independence Ave SE",
      city: "Washington",
      state_code: "DC",
      postcode: "20540",
      country_code: "US",
      phone_number: str(env.FALLBACK_PHONE) || "+1 206 555 0100",
      email: str(env.LULU_CONTACT_EMAIL) || "golpo.yta@protonmail.com",
    };

    const base = luluBase(env);
    const tok = await luluToken(env, base);
    result.steps.push({ step: "auth", ok: tok.ok, status: tok.status });
    if (!tok.ok) return json({ ...result, error: "lulu auth failed" });
    const token = tok.token;

    // ?cancel=<jobId> : cancel an UNPAID Lulu print job (operator cleanup). Token
    // gated by the same selftest token. Used to undo a job created by mistake.
    if (url.searchParams.get("cancel")) {
      const jid = url.searchParams.get("cancel");
      const c = await luluFetch(base, token, "/print-jobs/" + encodeURIComponent(jid) + "/status/", "PUT", { name: "CANCELED" });
      const chk = await luluFetch(base, token, "/print-jobs/" + encodeURIComponent(jid) + "/status/", "GET");
      return json({ ok: c.ok, jobId: jid, cancelStatus: c.status, jobStatus: chk.body ? chk.body.name : null, error: c.ok ? undefined : (c.raw || "").slice(0, 300) });
    }

    // ?costall=1 : quote EVERY Lulu shipping level for this book to a US address.
    // Cost calc only, no job is created. Answers "what shipping speeds and prices
    // does Lulu actually offer for these packages".
    if (url.searchParams.get("costall")) {
      const LEVELS = ["MAIL", "PRIORITY_MAIL", "GROUND_HD", "GROUND_BUS", "GROUND", "EXPEDITED", "EXPRESS"];
      const quotes = {};
      for (const lvl of LEVELS) {
        const c = await luluFetch(base, token, "/print-job-cost-calculations/", "POST", {
          line_items: built.lineItems.map((li) => ({ page_count: li.page_count, pod_package_id: li.pod_package_id, quantity: li.quantity })),
          shipping_address: address,
          shipping_option: lvl,
        });
        quotes[lvl] = c.ok
          ? {
              shipExcl: toNum(c.body && c.body.shipping_cost && c.body.shipping_cost.total_cost_excl_tax),
              printExcl: c.body && Array.isArray(c.body.line_item_costs) ? round2(c.body.line_item_costs.reduce((s, x) => s + toNum(x.total_cost_excl_tax), 0)) : null,
              totalExcl: toNum(c.body && c.body.total_cost_excl_tax),
              totalIncl: toNum(c.body && c.body.total_cost_incl_tax),
              currency: c.body && c.body.currency,
            }
          : { error: (c.raw || "").slice(0, 160) };
      }
      return json({ ok: true, product: product.title, quotesInclTax: quotes });
    }

    // Cost calc first: cheap, and it validates address plus package before we create.
    const calc = await luluFetch(base, token, "/print-job-cost-calculations/", "POST", {
      line_items: built.lineItems.map((li) => ({ page_count: li.page_count, pod_package_id: li.pod_package_id, quantity: li.quantity })),
      shipping_address: address,
      shipping_option: TIER.standard.shippingLevel,
    });
    result.steps.push({
      step: "costCalc", ok: calc.ok, status: calc.status,
      shipTotal: calc.ok && calc.body ? toNum(calc.body.shipping_cost && calc.body.shipping_cost.total_cost_incl_tax) : null,
      total: calc.ok && calc.body ? toNum(calc.body.total_cost_incl_tax) : null,
      error: calc.ok ? undefined : (calc.raw || "").slice(0, 500),
    });

    // Create. external_id marks it as a self test in the Lulu dashboard.
    const job = {
      external_id: "selftest_" + Date.now(),
      contact_email: str(env.LULU_CONTACT_EMAIL) || "golpo.yta@protonmail.com",
      line_items: built.lineItems,
      shipping_level: TIER.standard.shippingLevel,
      shipping_address: address,
    };
    const created = await luluFetch(base, token, "/print-jobs/", "POST", job);
    const jobId = created.ok && created.body && created.body.id != null ? String(created.body.id) : null;
    const statusAfterCreate = created.ok && created.body && created.body.status ? created.body.status.name : null;
    result.steps.push({
      step: "create", ok: created.ok, status: created.status, jobId, jobStatus: statusAfterCreate,
      external_id: job.external_id,
      error: created.ok ? undefined : (created.raw || "").slice(0, 800),
    });
    if (!jobId) {
      log("create failed", created.status);
      return json({ ...result, error: "create failed" });
    }

    // Cancel. Per the Lulu OpenAPI: PUT /print-jobs/{id}/status/ with {name: "CANCELED"}
    // (operationId Print-Jobs_status_cancel). Allowed from CREATED and UNPAID.
    const cancel = await luluFetch(base, token, "/print-jobs/" + encodeURIComponent(jobId) + "/status/", "PUT", { name: "CANCELED" });
    const statusAfterCancel = cancel.ok && cancel.body ? cancel.body.name : null;
    result.steps.push({
      step: "cancel", ok: cancel.ok, status: cancel.status, jobStatus: statusAfterCancel,
      error: cancel.ok ? undefined : (cancel.raw || "").slice(0, 800),
    });

    // Read back the status so the transition is confirmed by a second call.
    const check = await luluFetch(base, token, "/print-jobs/" + encodeURIComponent(jobId) + "/status/", "GET");
    result.steps.push({
      step: "statusRead", ok: check.ok, status: check.status,
      jobStatus: check.ok && check.body ? check.body.name : null,
      message: check.ok && check.body ? check.body.message : undefined,
    });

    const canceled = statusAfterCancel === "CANCELED" || (check.ok && check.body && check.body.name === "CANCELED");
    result.ok = canceled;
    result.jobId = jobId;
    result.transitions = [statusAfterCreate, statusAfterCancel, check.ok && check.body ? check.body.name : null].filter(Boolean);
    if (!canceled) {
      result.warning = "JOB " + jobId + " WAS CREATED BUT NOT CONFIRMED CANCELED. Cancel it in the Lulu dashboard.";
      log("WARNING selftest job not canceled", jobId);
    } else {
      log("selftest ok", jobId);
    }
    return json(result);
  } catch (e) {
    log("exception", String(e && e.message ? e.message : e));
    return json({ ...result, error: "internal", message: String(e && e.message ? e.message : e).slice(0, 200) });
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

// Expand a product row into Lulu line items, pulling each book's cover and
// interior URL from env. Returns {ok, lineItems, printCostUSD} or {ok:false, missing}
// where `missing` names the env vars that are blank (never their values).
function buildLineItems(env, product, saleQty) {
  const lineItems = [];
  const missing = [];
  let printCostUSD = 0;
  for (const line of product.lines) {
    const spec = BOOKS[line.book];
    if (!spec) { missing.push("BOOKS." + line.book); continue; }
    const cover = str(env[spec.coverEnv]);
    const interior = str(env[spec.interiorEnv]);
    if (!cover) missing.push(spec.coverEnv);
    if (!interior) missing.push(spec.interiorEnv);
    const quantity = (line.qty || 1) * saleQty;
    printCostUSD += spec.printCostUSD * quantity;
    lineItems.push({
      title: spec.title,
      pod_package_id: spec.pod_package_id,
      page_count: spec.page_count,
      quantity,
      printable_normalization: {
        pod_package_id: spec.pod_package_id,
        cover: { source_url: cover },
        interior: { source_url: interior },
      },
    });
  }
  if (missing.length) return { ok: false, missing };
  return { ok: true, lineItems, printCostUSD: round2(printCostUSD) };
}

// OAuth2 client_credentials against Lulu's Keycloak realm. Returns {ok, status, token}.
// The token is short lived and only ever held in memory for this request. It and
// the client secret are never logged or returned over HTTP.
async function luluToken(env, base) {
  let r;
  try {
    r = await fetch(base + "/auth/realms/glasstree/protocol/openid-connect/token", {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(String(env.LULU_CLIENT_KEY) + ":" + String(env.LULU_CLIENT_SECRET)),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: "grant_type=client_credentials",
    });
  } catch (e) {
    return { ok: false, status: 0 };
  }
  const body = await r.json().catch(() => null);
  if (!r.ok || !body || !body.access_token) return { ok: false, status: r.status };
  return { ok: true, status: r.status, token: String(body.access_token) };
}

// One authenticated Lulu call. Reads the raw text and parses JSON in a try/catch so
// an HTML error page or empty body cannot throw. Returns {ok, status, body, raw};
// callers log at most the first 500 chars of `raw` on failure.
async function luluFetch(base, token, path, method, payload) {
  const headers = { Authorization: "Bearer " + token, Accept: "application/json", "Cache-Control": "no-cache" };
  const init = { method, headers };
  if (payload !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(payload);
  }
  let r;
  try {
    r = await fetch(base + path, init);
  } catch (e) {
    return { ok: false, status: 0, body: null, raw: String(e && e.message ? e.message : e) };
  }
  const raw = await r.text().catch(() => "");
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch (e) { body = null; }
  return { ok: r.ok, status: r.status, body, raw };
}

// The owner's dashboard: "fail:<sale_id>" = why it needs a human. Best effort and
// PII free by construction (callers only pass reason/tier/status/product/net/cost).
async function recordFail(env, saleId, reason, extra) {
  try {
    if (!env || !env.ORDERS) return;
    await env.ORDERS.put("fail:" + saleId, JSON.stringify({ reason, at: new Date().toISOString(), ...(extra || {}) }));
  } catch (e) {
    console.log("[lulu] recordFail failed", saleId, reason);
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
