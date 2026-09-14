// Cloudflare Pages Function: Gumroad sale ping to Bookvault print order
// Route: POST https://marcuscole.pages.dev/api/bookvault
//        GET  https://marcuscole.pages.dev/api/bookvault?selftest=<token>  (operator only, see bottom)
//
// This is the Bookvault twin of functions/api/gumroad-lulu.js. Same safe shape:
// a customer buys a PHYSICAL paperback on Gumroad; Gumroad collects payment AND the
// per product shipping fee AND the address, then POSTs a "ping" here. We treat that ping
// as UNTRUSTED. The only thing we take from the ping is the sale_id; everything else
// (buyer, product, paid state, address) is re fetched from the Gumroad API with our own
// token, which an attacker cannot forge. Then we map the product to Bookvault title(s) by
// ISBN, create a FREE Draft order to learn the real cost, margin check it, and only then
// place the real order.
//
// PAYMENT MODEL: a Draft order (POST /Order?payMethod=Draft) is created and priced for
// FREE and prints nothing. Going live discards the draft and re POSTs the same order with
// Status Active and BOOKVAULT_PAY_METHOD ("Saved" = charge the saved card per order, the
// default; "Credit" = draw from a prepaid balance). No prepaid funds are needed for
// "Saved". The whole dry path is non billable; going live is a single flip of DRY_RUN.
//
// The BUNDLE is its own Bookvault title (its own ISBN, BOOKVAULT_ISBN_MC_BUNDLE), so one
// bundle sale = one order line = one parcel = one shipping charge, never per book.
//
// SECRETS (set in Cloudflare Pages, Settings, Environment variables, NEVER in the repo):
//   BOOKVAULT_API_KEY     the "bv_..." key from the Bookvault portal (Apps, Generate
//                         Credentials). Sent as the HTTP Basic credential (see bvAuth).
//   BOOKVAULT_ISBN_LOCKIN, BOOKVAULT_ISBN_YOURPHONE, BOOKVAULT_ISBN_MC_BUNDLE
//                         the 13 digit ISBN of each title AS IT EXISTS in your Bookvault
//                         Library (a validated title). MC_BUNDLE is the two book box/set title.
//                         Kept in env, never hardcoded.
//   BOOKVAULT_CONTACT_EMAIL   optional, owner email used on the self test.
//   BOOKVAULT_PAY_METHOD  optional, "Saved" (default) or "Credit".
//   FX_GBP_USD            optional, GBP->USD rate for the margin check when Bookvault
//                         prices in GBP (default 1.45, deliberately pessimistic so a
//                         GBP cost is never understated). Only GBP and USD are converted;
//                         any other currency leaves the margin UNVERIFIED and a live order
//                         is parked, never shipped blind.
//   GUMROAD_API_TOKEN     Gumroad API access token, used to fetch the authoritative sale.
//   GUMROAD_SELLER_ID     our Gumroad seller id; any sale not owned by it is rejected.
//   FALLBACK_PHONE        business phone used when the buyer gave none.
//   SELFTEST_TOKEN        gates the GET path (self test / draft probe / cancel).
//   DRY_RUN               anything other than the exact string "false" = price + validate
//                         via a Draft, then discard it. NOTHING is placed. Set to "false"
//                         only when ready to sell.
// BINDINGS (wrangler.toml): the existing ORDERS KV namespace, with Bookvault specific keys
//   bvorder:<sale_id> = Bookvault PodRef of a placed order (idempotency, never twice)
//   bvfail:<sale_id>  = why a paid sale needs manual handling (no PII stored)
//
// HTTP STATUS DISCIPLINE (identical to the Lulu function): every handled outcome returns
// 200 so Gumroad's ping log stays green and does not retry into a duplicate order. KV, not
// Gumroad's status colours, is the source of truth for what needs attention. Only 400 (no
// sale_id) and 403 (wrong seller / bad selftest token) are non 200.

const BV = "https://api.bookvault.app/v3";
const GUMROAD = "https://api.gumroad.com/v2";

// One row per printable title. isbnEnv names the env var holding that title's Bookvault
// Library ISBN (never the ISBN itself). Bookvault already holds the validated interior and
// cover in its Library, so an order line just references the title by ISBN.
const BOOKS = {
  lockin:    { title: "Lock In",              isbnEnv: "BOOKVAULT_ISBN_LOCKIN" },
  yourphone: { title: "Your Phone Owns You",  isbnEnv: "BOOKVAULT_ISBN_YOURPHONE" },
  bundle:    { title: "Marcus Cole Bundle",   isbnEnv: "BOOKVAULT_ISBN_MC_BUNDLE" },
};

// Product to book mapping. Kept identical to gumroad-lulu.js so either fulfilment endpoint
// resolves the same Gumroad product. Gumroad reports product_permalink as the SHORT code
// (e.g. "gofknx"), not the storefront slug, so each row carries both plus product_id. The
// bundle maps to its own Bookvault bundle title (one line) = one order = one shipping charge.
const PRODUCTS = [
  { title: "Lock In",             keys: ["gofknx", "lockinpaperback"],                                  lines: [{ book: "lockin", qty: 1 }] },
  { title: "Your Phone Owns You", keys: ["jmaasv", "yourphonepaperback"],                               lines: [{ book: "yourphone", qty: 1 }] },
  { title: "Marcus Cole Bundle",  keys: ["maecjf", "marcuspaperbackbundle", "1UKJeFBLB0BJ-4KlPWMMZQ=="], lines: [{ book: "bundle", qty: 1 }] },
];

const PRODUCT_INDEX = (() => {
  const idx = new Map();
  for (const p of PRODUCTS) for (const k of p.keys) { idx.set(k, p); idx.set(k.toLowerCase(), p); }
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

// Gumroad shipping version to Bookvault dispatch request. Bookvault picks the concrete
// carrier/service from the requested TYPE. Standard = cheapest tracked; Express = quickest.
const TIER = {
  standard: { requestedService: "CheapestTracked" },
  express:  { requestedService: "Quickest" },
};

// Countries we fulfil. Gumroad reports an ISO 3166-1 alpha-2 code; the UK is "GB", not "UK".
const SUPPORTED_COUNTRIES = new Set(["US", "CA", "GB", "AU"]);

// Minimum profit (USD) we accept on a single sale after Gumroad fees and the Bookvault
// order total (print + dispatch). Below this the sale is parked for a human instead of
// shipping at a loss. Tune as real numbers settle.
const MARGIN_FLOOR_USD = 1.5;

export async function onRequestPost(context) {
  const { request, env } = context;
  const log = (...a) => console.log("[bv]", ...a);

  let saleId = "";
  try {
    // ---- 1. parse the ping. We only need sale_id (and a couple of fast reject hints).
    const p = await parsePing(request);
    if (!p) return json({ ok: false, error: "bad body" }, 400);
    saleId = String(p.sale_id || "").trim();
    if (!saleId) return json({ ok: false, error: "no sale_id" }, 400);
    if (String(p.test) === "true") return json({ ok: true, skipped: "test" });
    if (p.seller_id && env.GUMROAD_SELLER_ID && p.seller_id !== env.GUMROAD_SELLER_ID) {
      log("seller mismatch on ping", saleId);
      return json({ ok: false, error: "seller mismatch" }, 403);
    }

    // ---- 2. config guard. Missing config is an ops problem, not a Gumroad problem.
    if (!env.GUMROAD_API_TOKEN || !env.GUMROAD_SELLER_ID || !env.BOOKVAULT_API_KEY) {
      log("missing config", saleId);
      await recordFail(env, saleId, "config");
      return json({ ok: false, needsManual: true, reason: "config" });
    }

    // ---- 3. idempotency. A placed order must never be created twice.
    const existing = await kvGet(env, "bvorder:" + saleId);
    if (existing) { log("duplicate ping", saleId, "podref", existing); return json({ ok: true, duplicate: true }); }

    // ---- 4. fetch the authoritative sale from Gumroad with OUR token.
    const sale = await fetchSale(env, saleId);
    if (!sale) { log("sale lookup failed", saleId); await recordFail(env, saleId, "sale lookup"); return json({ ok: false, needsManual: true, reason: "sale lookup" }); }

    // ---- 5. verify ownership and payment state.
    if (sale.seller_id !== env.GUMROAD_SELLER_ID) { log("seller mismatch on sale", saleId); return json({ ok: false, error: "seller mismatch" }, 403); }
    if (sale.paid !== true) { log("skip unpaid", saleId); return json({ ok: true, skipped: "unpaid" }); }
    if (sale.refunded || sale.partially_refunded || sale.chargedback || sale.disputed || sale.access_revoked) {
      log("skip refunded/disputed", saleId); return json({ ok: true, skipped: "refunded" });
    }

    // ---- 6. map the product to a book row.
    const product = lookupBook(sale);
    if (!product) {
      log("no mapping", saleId, sale.product_permalink);
      await recordFail(env, saleId, "no mapping", { product_permalink: sale.product_permalink || null, product_id: sale.product_id || null });
      return json({ ok: false, needsManual: true, reason: "no mapping" });
    }

    // ---- 7. shipping tier and quantity.
    const tier = detectTier(sale);
    const requestedService = TIER[tier].requestedService;
    log("tier evidence", saleId, "vaq=", JSON.stringify(str(sale.variants_and_quantity)), "to", tier, requestedService);
    const qty = Math.max(1, parseInt(sale.quantity, 10) || 1);

    // ---- 8. destination country (ISO2 on the API sale).
    const country = String(sale.country_iso2 || "").toUpperCase();
    if (!SUPPORTED_COUNTRIES.has(country)) {
      log("intl not supported", saleId, country);
      await recordFail(env, saleId, "intl not supported", { country: country || null, tier });
      return json({ ok: false, needsManual: true, reason: "intl not supported" });
    }

    // ---- 9. order lines: one Bookvault line per book, referenced by its Library ISBN.
    const built = buildOrderLines(env, product, qty);
    if (!built.ok) {
      log("missing isbn env", saleId, built.missing);
      await recordFail(env, saleId, "missing isbn", { missing: built.missing, tier });
      return json({ ok: false, needsManual: true, reason: "missing isbn" });
    }

    // ---- 10. ship to address, from the API sale only. Bookvault requires Addressee,
    // Address1, Town and County; Email is required for a tracked service (both tiers are
    // tracked). County is blank for many GB/AU buyers, so fall back to the town there.
    const county = str(sale.state) || (country === "US" ? "" : str(sale.city));
    const address = {
      Addressee: str(sale.full_name),
      Address1: str(sale.street_address),
      Town: str(sale.city),
      County: county,
      Postcode: str(sale.zip_code),
      Country: { ISO_Code: country },
      TelNumber: str(sale.phone || sale.phone_number) || str(env.FALLBACK_PHONE),
      Email: str(sale.email || sale.purchase_email),
    };
    if (!address.Addressee || !address.Address1 || !address.Town || !address.County || !address.Postcode) {
      log("blank address", saleId);
      await recordFail(env, saleId, "blank address", { tier, country });
      return json({ ok: false, needsManual: true, reason: "blank address" });
    }
    if (!address.Email) { await recordFail(env, saleId, "no email", { tier }); return json({ ok: false, needsManual: true, reason: "no email" }); }
    if (!address.TelNumber) { await recordFail(env, saleId, "no phone", { tier }); return json({ ok: false, needsManual: true, reason: "no phone" }); }

    // ---- 11. build the order body. DocRef is our Gumroad sale id (Bookvault reference +
    // our idempotency lock). OrderMethod is server set (readOnly), so we do not send it.
    const orderBody = {
      DocRef: saleId,
      Status: "Draft",
      Address: address,
      DispatchRequest: { RequestedService: requestedService },
      OrderLines: built.lines,
      Notifications: { NotifyCustomer: false },
      ...customsFor(country),
    };

    // ---- 12. FREE Draft to price and validate. payMethod=Draft never charges or prints.
    const draft = await bvFetch(env, "/Order?payMethod=Draft", "POST", orderBody);
    if (!draft.ok || !draft.body) {
      log("draft failed", saleId, draft.status);
      await recordFail(env, saleId, "draft failed", { status: draft.status, tier, messages: errorCodes(draft.body) });
      return json({ ok: false, needsManual: true, reason: "draft failed" });
    }
    const podRef = draft.body.PodRef != null ? String(draft.body.PodRef) : null;
    const lineErrors = (draft.body.OrderLines || []).map((l) => l && l.ErrorCode).filter((e) => e && e !== "OK");
    const draftErrs = errorMessages(draft.body);
    if (draft.body.CriticalError || lineErrors.length || draftErrs.length) {
      log("draft has errors", saleId, "podref", podRef, "lineErrors", lineErrors.join(","), "msg", draftErrs.map((m) => m.Code).join(","));
      await recordFail(env, saleId, "draft invalid", { podRef, lineErrors, messages: draftErrs.map((m) => m.Code), tier });
      if (podRef) await bvFetch(env, "/Order?PodRef=" + encodeURIComponent(podRef), "DELETE");
      return json({ ok: false, needsManual: true, reason: "draft invalid", lineErrors });
    }

    // ---- 13. margin floor. net (USD) = (price - gumroad_fee)/100 from the sale, which
    // INCLUDES the shipping the customer paid at checkout. cost = the Bookvault GrandTotal,
    // converted to USD (GBP via FX_GBP_USD, USD as is). An unconvertible currency leaves the
    // margin UNVERIFIED, and a live order is then parked rather than shipped blind (below).
    const cost = draft.body.OrderCost || {};
    const orderCurrency = detectOrderCurrency(draft.body);
    const net = (toNum(sale.price) - toNum(sale.gumroad_fee)) / 100;
    const costUSD = toUSD(cost.GrandTotal, orderCurrency, env);
    let margin = null, marginChecked = false;
    if (costUSD != null) {
      marginChecked = true;
      margin = round2(net - costUSD);
      log("margin", saleId, "net", round2(net), "grandTotal", cost.GrandTotal, orderCurrency, "costUSD", costUSD, "margin", margin);
      if (margin < MARGIN_FLOOR_USD) {
        log("margin below floor", saleId);
        await recordFail(env, saleId, "margin below floor", { net: round2(net), grandTotal: cost.GrandTotal, currency: orderCurrency, costUSD, tier });
        if (podRef) await bvFetch(env, "/Order?PodRef=" + encodeURIComponent(podRef), "DELETE");
        return json({ ok: false, needsManual: true, reason: "margin below floor" });
      }
    } else {
      log("margin unverified", saleId, "currency", orderCurrency, "grandTotal", cost.GrandTotal);
    }

    // ---- 14. dry run: the draft ran for real (auth, pricing, validation, margin). Discard
    // it, and never echo buyer PII. Surface the cost breakdown so economics are visible.
    const dryRun = String(env.DRY_RUN ?? "true") !== "false";
    if (dryRun) {
      log("DRY_RUN", saleId, product.title, tier, "podref", podRef, "grandTotal", cost.GrandTotal, orderCurrency, "marginChecked", marginChecked);
      if (podRef) await bvFetch(env, "/Order?PodRef=" + encodeURIComponent(podRef), "DELETE");
      return json({
        ok: true, dryRun: true, tier, requestedService, product: product.title,
        currency: orderCurrency, productionCost: cost.ProductionCost ?? null, dispatchCost: cost.DispatchCost ?? null,
        grandTotal: cost.GrandTotal ?? null, costUSD, netUSD: round2(net), marginUSD: margin, marginChecked,
        would: { DocRef: saleId, lines: built.lines.map((l) => ({ ISBN: l.ISBN, Quantity: l.Quantity })), country },
      });
    }

    // ---- 15. live: margin MUST be verified before spending money. If we could not convert
    // the currency to USD, park it (fail closed) rather than ship at an unknown margin.
    if (!marginChecked) {
      await recordFail(env, saleId, "margin unverified", { currency: orderCurrency, grandTotal: cost.GrandTotal, tier });
      if (podRef) await bvFetch(env, "/Order?PodRef=" + encodeURIComponent(podRef), "DELETE");
      return json({ ok: false, needsManual: true, reason: "margin unverified" });
    }

    // Discard the pricing draft, then place the real order. If the delete fails we do NOT
    // place, so a lingering draft + a live order never share one DocRef.
    if (podRef) {
      const del = await bvFetch(env, "/Order?PodRef=" + encodeURIComponent(podRef), "DELETE");
      if (!del.ok) {
        log("draft delete failed, not placing", saleId, "podref", podRef, del.status);
        await recordFail(env, saleId, "draft delete failed", { podRef, status: del.status, tier });
        return json({ ok: false, needsManual: true, reason: "draft delete failed" });
      }
    }
    const payMethod = str(env.BOOKVAULT_PAY_METHOD) || "Saved";
    const liveBody = { ...orderBody, Status: "Active" };
    const placed = await bvFetch(env, "/Order?payMethod=" + encodeURIComponent(payMethod), "POST", liveBody);
    const rbody = (placed && placed.body) || {};
    const newRef = rbody.PodRef != null ? String(rbody.PodRef) : null;

    // If Bookvault accepted the call (any 2xx), an order may now EXIST even if it is not a
    // clean success. Lock the sale id immediately so a Gumroad retry cannot create a second
    // order, then decide success. Success = Active, no payment link, no critical/error msgs.
    if (placed.ok) await kvPut(env, "bvorder:" + saleId, newRef || "unconfirmed");

    const placedStatus = rbody.Status || null;
    const placeErrs = errorMessages(rbody);
    const settled = placed.ok && newRef && placedStatus === "Active" &&
      !(rbody.OrderCost && rbody.OrderCost.PaymentLink) && !rbody.CriticalError && placeErrs.length === 0;
    if (!settled) {
      log("not settled", saleId, "http", placed.status, "podref", newRef, "status", placedStatus, "msg", placeErrs.map((m) => m.Code).join(","));
      await recordFail(env, saleId, "not settled", { podRef: newRef, status: placedStatus, payMethod, messages: placeErrs.map((m) => m.Code), tier });
      return json({ ok: false, needsManual: true, reason: "not settled", podRef: newRef });
    }

    log("ORDER PLACED", saleId, product.title, tier, "podref", newRef, "status", placedStatus, "pay", payMethod);
    return json({ ok: true, podRef: newRef, status: placedStatus, tier, requestedService, payMethod });
  } catch (e) {
    console.log("[bv] exception", saleId, String(e && e.message ? e.message : e));
    if (saleId) await recordFail(env, saleId, "exception", { message: String(e && e.message ? e.message : e).slice(0, 200) });
    return json({ ok: false, error: "internal" });
  }
}

// ---------------------------------------------------------------- self test (GET)
//
// Operator only, token gated. Proves the whole Bookvault path for FREE, in stages:
//   (no extra param)   GET /Account            confirm the API key, auth header, saved card
//   ?draft=<book>      POST Draft + DELETE      price a real order to a test address, free
//   ?draft=bundle      "                        price the bundle title (one shipping charge)
//   ?validate=<book>   POST /ValidateOrder      full validate (no payment)
//   ?getorder=<ref>    GET /Order?PodRef        read one order back (address redacted)
//   ?cancel=<ref>      DELETE /Order?PodRef      cancel/discard an order (operator cleanup)
// <book> is lockin | yourphone | bundle. Nothing here is billable. If BOOKVAULT_API_KEY is
// unset the whole GET path is closed (403).
export async function onRequestGet(context) {
  const { request, env } = context;
  const log = (...a) => console.log("[bv selftest]", ...a);

  let url;
  try { url = new URL(request.url); } catch (e) { return json({ ok: false, error: "bad url" }, 400); }
  const selftestToken = str(env.SELFTEST_TOKEN);
  if (!selftestToken || url.searchParams.get("selftest") !== selftestToken) return json({ ok: false, error: "forbidden" }, 403);
  if (!env.BOOKVAULT_API_KEY) return json({ ok: false, error: "missing BOOKVAULT_API_KEY" });

  try {
    // Documented Basic header is `basic bv_KEY` (the key itself). On a 401 we retry the
    // standard base64(key:"") form and report which one authenticated.
    const acct = await bvFetch(env, "/Account", "GET");
    let authForm = "documented", ok = acct.ok, body = acct.body, status = acct.status;
    if (!acct.ok && acct.status === 401) {
      const alt = await bvFetch(env, "/Account", "GET", undefined, "base64");
      if (alt.ok) { authForm = "base64"; ok = true; body = alt.body; status = alt.status; } else status = alt.status;
    }

    // Financial.PayTerms[0] holds the saved card + the currency Bookvault will bill you in.
    // Seeing a saved card here is the pre-flight for BOOKVAULT_PAY_METHOD=Saved.
    const term = body && body.Financial && Array.isArray(body.Financial.PayTerms) ? body.Financial.PayTerms[0] : null;
    const card = term && term.SavedCard ? term.SavedCard : null;
    const result = {
      ok, base: BV, authForm: ok ? authForm : null, httpStatus: status,
      account: ok && body ? {
        email: body.Email || null,
        name: [body.FirstName, body.LastName].filter(Boolean).join(" ") || null,
        setupComplete: body.Setup ? (body.Setup.SetupComplete ?? null) : null,
        billingCurrency: term ? (term.Currency || null) : null,
        savedCard: card ? { brand: card.Brand || null, last4: card.Last4 || null, currency: card.Currency || null } : null,
        remainingFunds: term ? (term.RemainingFunds ?? null) : null,
      } : null,
      error: ok ? undefined : (acct.raw || "").slice(0, 200),
    };
    if (!ok) return json(result);

    const authOverride = authForm === "base64" ? "base64" : undefined;
    const testAddress = {
      Addressee: "Selftest Do Not Ship", Address1: "101 Independence Ave SE", Town: "Washington",
      County: "DC", Postcode: "20540", Country: { ISO_Code: "US" },
      TelNumber: str(env.FALLBACK_PHONE) || "+1 206 555 0100", Email: str(env.BOOKVAULT_CONTACT_EMAIL) || "customers@bookvault.app",
    };

    // ?getorder=<PodRef>: read one order back (address redacted to country + postcode).
    if (url.searchParams.get("getorder")) {
      const ref = url.searchParams.get("getorder");
      const d = await bvFetch(env, "/Order?PodRef=" + encodeURIComponent(ref), "GET", undefined, authOverride);
      const o = d.body || {};
      return json({ ...result, getorder: {
        podRef: ref, ok: d.ok, status: d.status, orderStatus: o.Status,
        cost: o.OrderCost ? { grandTotal: o.OrderCost.GrandTotal, dispatch: o.OrderCost.DispatchCost } : null,
        ship: o.Address ? { country: o.Address.Country ? o.Address.Country.ISO_Code : null, postcode: o.Address.Postcode } : null,
        lines: (o.OrderLines || []).map((l) => ({ ISBN: l.ISBN, Quantity: l.Quantity, ErrorCode: l.ErrorCode })),
        error: d.ok ? undefined : (d.raw || "").slice(0, 200) } });
    }
    // ?cancel=<PodRef>: cancel/discard an order (operator cleanup).
    if (url.searchParams.get("cancel")) {
      const ref = url.searchParams.get("cancel");
      const d = await bvFetch(env, "/Order?PodRef=" + encodeURIComponent(ref), "DELETE", undefined, authOverride);
      return json({ ...result, cancel: { podRef: ref, ok: d.ok, status: d.status, error: d.ok ? undefined : (d.raw || "").slice(0, 200) } });
    }

    const bookKey = url.searchParams.get("draft") || url.searchParams.get("validate");
    if (bookKey) {
      const lines = selftestLines(env, bookKey);
      if (!lines.ok) return json({ ...result, error: lines.error });
      const orderBody = {
        DocRef: "selftest_" + Date.now(), Status: "Draft", Address: testAddress,
        DispatchRequest: { RequestedService: "CheapestTracked" },
        OrderLines: lines.lines, Notifications: { NotifyCustomer: false }, ...customsFor("US"),
      };

      // ?validate=<book>: full validation, no payment, nothing created.
      if (url.searchParams.get("validate")) {
        const v = await bvFetch(env, "/ValidateOrder?type=FullButPayment", "POST", orderBody, authOverride);
        const vb = v.body || {};
        return json({ ...result, validate: { book: bookKey, ok: v.ok, status: v.status, criticalError: vb.CriticalError ?? null,
          lineErrors: (vb.OrderLines || []).map((l) => l.ErrorCode), messages: errorMessages(vb).map((m) => m.Code),
          grandTotal: vb.OrderCost ? vb.OrderCost.GrandTotal : null, error: v.ok ? undefined : (v.raw || "").slice(0, 200) } });
      }

      // ?draft=<book|bundle>: FREE Draft to prove pricing + one shipping charge, then DELETE.
      const d = await bvFetch(env, "/Order?payMethod=Draft", "POST", orderBody, authOverride);
      const db = d.body || {};
      const podRef = db.PodRef != null ? String(db.PodRef) : null;
      let deleted = null;
      if (podRef) { const del = await bvFetch(env, "/Order?PodRef=" + encodeURIComponent(podRef), "DELETE", undefined, authOverride); deleted = del.ok; }
      const c = db.OrderCost || {};
      return json({ ...result, draft: {
        book: bookKey, lines: orderBody.OrderLines.length, ok: d.ok, status: d.status, podRef,
        criticalError: db.CriticalError ?? null, lineErrors: (db.OrderLines || []).map((l) => l.ErrorCode),
        messages: errorMessages(db).map((m) => m.Code),
        currency: detectOrderCurrency(db), productionCost: c.ProductionCost ?? null, dispatchCost: c.DispatchCost ?? null, grandTotal: c.GrandTotal ?? null,
        deletedDraft: deleted, error: d.ok ? undefined : (d.raw || "").slice(0, 200) } });
    }

    return json(result);
  } catch (e) {
    log("exception", String(e && e.message ? e.message : e));
    return json({ ok: false, error: "internal", message: String(e && e.message ? e.message : e).slice(0, 200) });
  }
}

// ---------------------------------------------------------------- helpers

// Bookvault HTTP Basic. Documented form is `Authorization: basic <bv_key>`. The base64 form
// base64(key:"") is the standard encoding, offered as a self test fallback. Never logged.
function bvAuth(env, form) {
  const key = String(env.BOOKVAULT_API_KEY || "");
  if (form === "base64") return "Basic " + btoa(key + ":");
  return "basic " + key;
}

async function bvFetch(env, path, method, payload, authForm) {
  const headers = { Authorization: bvAuth(env, authForm), Accept: "application/json" };
  const init = { method, headers };
  if (payload !== undefined) { headers["Content-Type"] = "application/json"; init.body = JSON.stringify(payload); }
  let r;
  try { r = await fetch(BV + path, init); } catch (e) { return { ok: false, status: 0, body: null, raw: String(e && e.message ? e.message : e) }; }
  const raw = await r.text().catch(() => "");
  let body = null; try { body = raw ? JSON.parse(raw) : null; } catch (e) { body = null; }
  return { ok: r.ok, status: r.status, body, raw };
}

async function parsePing(request) {
  try { return Object.fromEntries((await request.formData()).entries()); }
  catch (e) { try { return Object.fromEntries(new URLSearchParams(await request.text()).entries()); } catch (e2) { return null; } }
}

async function fetchSale(env, saleId) {
  const url = GUMROAD + "/sales/" + encodeURIComponent(saleId) + "?access_token=" + encodeURIComponent(env.GUMROAD_API_TOKEN);
  let r; try { r = await fetch(url, { headers: { Accept: "application/json" } }); } catch (e) { return null; }
  if (!r.ok) return null;
  const body = await r.json().catch(() => null);
  if (!body || body.success === false) return null;
  const sale = body.sale || (Array.isArray(body.sales) ? body.sales[0] : null);
  if (!sale || typeof sale !== "object") return null;
  if (sale.id && String(sale.id) !== saleId) return null;
  return sale;
}

function detectTier(sale) {
  const hay = String(sale.variants_and_quantity || "") + " " + JSON.stringify(sale.variants || "");
  return /express|quick|ups|priority|fast/i.test(hay) ? "express" : "standard";
}

// Expand a product row into Bookvault order lines by ISBN. Returns {ok, lines} or
// {ok:false, missing} naming the blank env vars (never their values).
function buildOrderLines(env, product, saleQty) {
  const lines = []; const missing = [];
  for (const line of product.lines) {
    const spec = BOOKS[line.book];
    if (!spec) { missing.push("BOOKS." + line.book); continue; }
    const isbn = str(env[spec.isbnEnv]);
    if (!isbn) { missing.push(spec.isbnEnv); continue; }
    lines.push({ ISBN: isbn, Quantity: (line.qty || 1) * saleQty });
  }
  if (missing.length) return { ok: false, missing };
  return { ok: true, lines };
}

// Self test line builder: one line for the chosen title (lockin | yourphone | bundle).
function selftestLines(env, key) {
  const book = BOOKS[key];
  if (!book) return { ok: false, error: "unknown book, use lockin, yourphone or bundle" };
  const isbn = str(env[book.isbnEnv]);
  if (!isbn) return { ok: false, error: "missing " + book.isbnEnv };
  return { ok: true, lines: [{ ISBN: isbn, Quantity: 1 }] };
}

// Non GB destinations are overseas shipments from the UK, so Bookvault requires a customs
// declaration. Books are HS 4901.99 (printed books). UseOrderValue takes the declared value
// from the order. DDU = recipient pays any import duty on delivery (books are usually duty
// free under de minimis into US/CA/AU). Domestic GB orders need none.
function customsFor(country) {
  if (String(country).toUpperCase() === "GB") return {};
  return { CustomsDeclaration: { UseOrderValue: true, HSCode: "4901990000", IncoTerms: "DDU", UseIOSS: false } };
}

// Currency of the order = the partner's CurrencyID (BookVAULT.OrderCost has no currency).
function detectOrderCurrency(order) {
  const c = order && order.Partner && (order.Partner.CurrencyID || order.Partner.Currency);
  return c ? String(c).toUpperCase() : null;
}

// Convert a Bookvault cost to USD for the margin check. USD as is; GBP via FX_GBP_USD
// (default 1.45, pessimistic). Any other/unknown currency returns null = unverified.
function toUSD(amount, currency, env) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  if (currency === "USD") return round2(n);
  if (currency === "GBP") { const fx = Number(env.FX_GBP_USD) || 1.45; return round2(n * fx); }
  return null;
}

// Error-level messages on a Bookvault order body (BookVAULT.Order.Messages).
function errorMessages(body) {
  const arr = body && Array.isArray(body.Messages) ? body.Messages : [];
  return arr.filter((m) => m && String(m.Level) === "Error").map((m) => ({ Code: m.Code || null, text: m.ErrorText || m.Text || m.Message || "" }));
}
function errorCodes(body) { return errorMessages(body).map((m) => m.Code); }

async function recordFail(env, saleId, reason, extra) {
  try { if (env && env.ORDERS) await env.ORDERS.put("bvfail:" + saleId, JSON.stringify({ reason, at: new Date().toISOString(), ...(extra || {}) })); }
  catch (e) { console.log("[bv] recordFail failed", saleId, reason); }
}
async function kvGet(env, key) { try { return env.ORDERS ? await env.ORDERS.get(key) : null; } catch (e) { return null; } }
async function kvPut(env, key, value) { try { if (!env.ORDERS) return false; await env.ORDERS.put(key, value); return true; } catch (e) { return false; } }

function str(v) { return v == null ? "" : String(v).trim(); }
function toNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function round2(n) { return Math.round(n * 100) / 100; }
function json(obj, status = 200) { return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } }); }
