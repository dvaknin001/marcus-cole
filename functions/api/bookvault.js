// Cloudflare Pages Function: Gumroad sale ping to Bookvault print order
// Route: POST https://marcuscole.pages.dev/api/bookvault
//        GET  https://marcuscole.pages.dev/api/bookvault?selftest=<token>  (operator only, see bottom)
//
// This is the Bookvault twin of functions/api/gumroad-lulu.js. Same safe shape:
// a customer buys a PHYSICAL paperback on Gumroad; Gumroad collects payment and the
// shipping address, then POSTs a "ping" here. We treat that ping as UNTRUSTED (anyone
// who knows this URL can POST to it). The only thing we take from the ping is the
// sale_id; everything else (buyer, product, paid state, address) is re fetched from
// the Gumroad API with our own token, which an attacker cannot forge. Then we map the
// product to a Bookvault title (by ISBN), create a FREE Draft order to learn the real
// cost, check the margin, and only then RELEASE it into production.
//
// PAYMENT MODEL (why the live path is safe to switch on): Bookvault orders draw down a
// PREPAID account balance. A Draft order (payMethod=Draft) is created and priced for
// FREE and prints nothing; it only enters production when it is RELEASED
// (PUT /Order?UpdateType=ReleaseOrder). So the whole dry path below is non billable,
// and going live is a single deliberate flip of DRY_RUN plus a funded balance.
//
// SECRETS (set in Cloudflare Pages, Settings, Environment variables, NEVER in the repo):
//   BOOKVAULT_API_KEY     the "bv_..." key from the Bookvault portal (Apps, Generate
//                         Credentials). Sent as the HTTP Basic credential (see bvAuth).
//   BOOKVAULT_ISBN_LOCKIN, BOOKVAULT_ISBN_YOURPHONE
//                         the 13 digit ISBN of each title AS IT EXISTS in your Bookvault
//                         Library (a validated title). Kept in env so a title can be
//                         re uploaded or renumbered without a code edit. No ISBN is ever
//                         hardcoded here.
//   BOOKVAULT_CONTACT_EMAIL   optional, owner email used on the order/self test.
//   GUMROAD_API_TOKEN     Gumroad API access token, used to fetch the authoritative sale.
//   GUMROAD_SELLER_ID     our Gumroad seller id; any sale not owned by it is rejected.
//   FALLBACK_PHONE        business phone used when the buyer gave none.
//   SELFTEST_TOKEN        gates the GET path (self test / draft probe / cancel).
//   DRY_RUN               anything other than the exact string "false" = price the order
//                         via a Draft and validate it, then discard the Draft. NOTHING is
//                         released to production. Set to "false" only when ready to sell.
// BINDINGS (wrangler.toml): the existing ORDERS KV namespace, with Bookvault specific keys
//   bvorder:<sale_id> = Bookvault PodRef of a released order (idempotency, never twice)
//   bvfail:<sale_id>  = why a paid sale needs manual handling (no PII stored)
//
// HTTP STATUS DISCIPLINE (identical to the Lulu function): every handled outcome returns
// 200 so Gumroad's ping log stays green and does not retry into a duplicate order. KV, not
// Gumroad's status colours, is the source of truth for what needs attention. Only 400 (no
// sale_id) and 403 (wrong seller / bad selftest token) are non 200.

const BV = "https://api.bookvault.app/v3";
const GUMROAD = "https://api.gumroad.com/v2";

// One row per printable title. isbnEnv names the env var holding that title's Bookvault
// Library ISBN (never the ISBN itself). No print files or page counts are needed here:
// unlike Lulu, Bookvault already holds the validated interior and cover in its Library,
// and an order line just references the title by ISBN.
const BOOKS = {
  lockin:    { title: "Lock In",              isbnEnv: "BOOKVAULT_ISBN_LOCKIN" },
  yourphone: { title: "Your Phone Owns You",  isbnEnv: "BOOKVAULT_ISBN_YOURPHONE" },
};

// Product to book mapping. Kept identical to gumroad-lulu.js so either fulfilment endpoint
// resolves the same Gumroad product. Gumroad reports product_permalink as the SHORT code
// (e.g. "gofknx"), not the storefront slug, so each row carries both plus product_id.
const PRODUCTS = [
  { title: "Lock In",             keys: ["gofknx", "lockinpaperback"],                                  lines: [{ book: "lockin", qty: 1 }] },
  { title: "Your Phone Owns You", keys: ["jmaasv", "yourphonepaperback"],                               lines: [{ book: "yourphone", qty: 1 }] },
  { title: "Marcus Cole Bundle",  keys: ["maecjf", "marcuspaperbackbundle", "1UKJeFBLB0BJ-4KlPWMMZQ=="], lines: [{ book: "lockin", qty: 1 }, { book: "yourphone", qty: 1 }] },
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
// carrier/service from the requested TYPE, so we ask for a tracked service and let it
// choose the cheapest one that matches. Standard = cheapest tracked; Express = quickest.
const TIER = {
  standard: { requestedService: "CheapestTracked" },
  express:  { requestedService: "Quickest" },
};

// Countries we fulfil. Gumroad reports the destination as an ISO 3166-1 alpha-2 code,
// where the United Kingdom is "GB" (not "UK"). Book Vault prints from the UK and ships
// worldwide, so a CA/GB/AU order is priced and dispatched the same way as a US one; the
// margin floor still guards against the higher international postage.
const SUPPORTED_COUNTRIES = new Set(["US", "CA", "GB", "AU"]);

// Minimum profit (USD) we accept on a single sale after Gumroad fees and the Bookvault
// order total (print + dispatch). Below this the sale is parked for a human instead of
// shipping at a loss. Margin is only enforced when the Bookvault order is priced in USD
// (see below); a non USD account total is logged and the check is skipped, never guessed.
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

    // ---- 3. idempotency. A released order must never be created twice.
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
    // Address1, Town and County; we also pass postcode, phone (with fallback) and email.
    const address = {
      Addressee: str(sale.full_name),
      Address1: str(sale.street_address),
      Town: str(sale.city),
      County: str(sale.state),
      Postcode: str(sale.zip_code),
      Country: { ISO_Code: country },
      TelNumber: str(sale.phone || sale.phone_number) || str(env.FALLBACK_PHONE),
      Email: str(sale.email || sale.purchase_email),
    };
    if (!address.Addressee || !address.Address1 || !address.Town || !address.County || !address.Postcode) {
      log("blank address", saleId);
      await recordFail(env, saleId, "blank address", { tier });
      return json({ ok: false, needsManual: true, reason: "blank address" });
    }
    if (!address.TelNumber) {
      log("no phone and no FALLBACK_PHONE", saleId);
      await recordFail(env, saleId, "no phone", { tier });
      return json({ ok: false, needsManual: true, reason: "no phone" });
    }

    // ---- 11. build the order body. DocRef is our Gumroad sale id (Bookvault reference +
    // our own idempotency lock). Created as a Draft first so pricing is free.
    const orderBody = {
      DocRef: saleId,
      OrderMethod: "API",
      Status: "Draft",
      Address: address,
      DispatchRequest: { RequestedService: requestedService },
      OrderLines: built.lines,
      Notifications: { NotifyCustomer: false },
      ...customsFor(country),
    };

    // ---- 12. create the FREE Draft to price and validate the order. payMethod=Draft never
    // charges and never prints. The response carries a PodRef, per line ErrorCode and the
    // OrderCost we margin check against.
    const draft = await bvFetch(env, "/Order?payMethod=Draft", "POST", orderBody);
    if (!draft.ok || !draft.body) {
      log("draft failed", saleId, draft.status, (draft.raw || "").slice(0, 400));
      await recordFail(env, saleId, "draft failed", { status: draft.status, tier, bvError: (draft.raw || "").slice(0, 400) });
      return json({ ok: false, needsManual: true, reason: "draft failed" });
    }
    const podRef = draft.body.PodRef != null ? String(draft.body.PodRef) : null;
    const lineErrors = (draft.body.OrderLines || []).map((l) => l && l.ErrorCode).filter((e) => e && e !== "OK");
    if (draft.body.CriticalError || lineErrors.length) {
      log("draft has errors", saleId, "podref", podRef, "lineErrors", lineErrors.join(","));
      await recordFail(env, saleId, "draft invalid", { podRef, lineErrors, tier });
      if (podRef) await bvFetch(env, "/Order?PodRef=" + encodeURIComponent(podRef), "DELETE");
      return json({ ok: false, needsManual: true, reason: "draft invalid", lineErrors });
    }

    // ---- 13. margin floor. net (USD) = (price - gumroad_fee)/100 from the sale. cost =
    // the Bookvault order GrandTotal. Only compare when the order is priced in USD; a GBP
    // or EUR total is not comparable to a USD net, so we log and skip rather than guess.
    const cost = draft.body.OrderCost || {};
    const orderCurrency = detectOrderCurrency(draft.body);
    const net = (toNum(sale.price) - toNum(sale.gumroad_fee)) / 100;
    let margin = null, marginChecked = false;
    if (Number.isFinite(Number(cost.GrandTotal)) && orderCurrency === "USD") {
      marginChecked = true;
      margin = round2(net - Number(cost.GrandTotal));
      log("margin", saleId, "net", round2(net), "grandTotal", cost.GrandTotal, "margin", margin);
      if (margin < MARGIN_FLOOR_USD) {
        log("margin below floor", saleId);
        await recordFail(env, saleId, "margin below floor", { net: round2(net), grandTotal: cost.GrandTotal, tier });
        if (podRef) await bvFetch(env, "/Order?PodRef=" + encodeURIComponent(podRef), "DELETE");
        return json({ ok: false, needsManual: true, reason: "margin below floor" });
      }
    } else {
      log("margin skipped", saleId, "currency", orderCurrency, "grandTotal", cost.GrandTotal);
    }

    // ---- 14. dry run: the draft ran for real (auth, pricing, validation, margin). Discard
    // it so nothing lingers, and never echo buyer PII over HTTP.
    const dryRun = String(env.DRY_RUN ?? "true") !== "false";
    if (dryRun) {
      log("DRY_RUN", saleId, product.title, tier, "podref", podRef, "grandTotal", cost.GrandTotal, "marginChecked", marginChecked);
      if (podRef) await bvFetch(env, "/Order?PodRef=" + encodeURIComponent(podRef), "DELETE");
      return json({
        ok: true, dryRun: true, tier, requestedService,
        grandTotal: cost.GrandTotal ?? null, currency: orderCurrency, marginChecked, marginOK: marginChecked ? true : null,
        would: { DocRef: saleId, lines: built.lines.map((l) => ({ ISBN: l.ISBN, Quantity: l.Quantity })), country, hasAddress: true },
      });
    }

    // ---- 15. live: RELEASE the draft into production. This is the only billable step and
    // draws from the prepaid balance. If the balance is short, Bookvault returns a payment
    // link instead of releasing; we treat that as needsManual (top up, then release by hand).
    const release = await bvFetch(env, "/Order?UpdateType=ReleaseOrder&PodRef=" + encodeURIComponent(podRef), "PUT", orderBody);
    if (!release.ok) {
      log("release failed", saleId, release.status, (release.raw || "").slice(0, 400));
      await recordFail(env, saleId, "release failed", { podRef, status: release.status, tier, bvError: (release.raw || "").slice(0, 400) });
      return json({ ok: false, needsManual: true, reason: "release failed" });
    }
    const rbody = release.body || {};
    const releasedStatus = rbody.Status || null;
    const paymentLink = rbody.OrderCost && rbody.OrderCost.PaymentLink ? true : false;
    if (releasedStatus === "Draft" || paymentLink) {
      // Still a draft / a payment link came back = balance not sufficient to release.
      await recordFail(env, saleId, "needs funds", { podRef, tier });
      log("release needs funds", saleId, "podref", podRef);
      return json({ ok: false, needsManual: true, reason: "needs funds", podRef });
    }

    // Record the PodRef BEFORE answering so a retried ping can never double order.
    const saved = await kvPut(env, "bvorder:" + saleId, podRef);
    if (!saved) log("WARNING order released but KV write failed", saleId, "podref", podRef);
    log("ORDER RELEASED", saleId, product.title, tier, "podref", podRef, "status", releasedStatus);
    return json({ ok: true, podRef, status: releasedStatus, tier, requestedService });
  } catch (e) {
    console.log("[bv] exception", saleId, String(e && e.message ? e.message : e));
    if (saleId) await recordFail(env, saleId, "exception", { message: String(e && e.message ? e.message : e).slice(0, 200) });
    return json({ ok: false, error: "internal" });
  }
}

// ---------------------------------------------------------------- self test (GET)
//
// Operator only, token gated. Proves the whole Bookvault path for FREE, in stages:
//   (no extra param)  GET /Account            confirm the API key + auth header work
//   ?draft=<book>     POST Draft + DELETE     price a real order to a test address, free
//   ?validate=<book>  POST /ValidateOrder      full validate (no payment) of an order
//   ?getorder=<ref>   GET /Order?PodRef        read one order back
//   ?cancel=<ref>     DELETE /Order?PodRef     cancel/discard an order (operator cleanup)
// <book> is a key of BOOKS (lockin | yourphone). Nothing here is ever RELEASED, so nothing
// is billable. If BOOKVAULT_API_KEY is unset the whole GET path is closed (403).
export async function onRequestGet(context) {
  const { request, env } = context;
  const log = (...a) => console.log("[bv selftest]", ...a);

  let url;
  try { url = new URL(request.url); } catch (e) { return json({ ok: false, error: "bad url" }, 400); }
  const selftestToken = str(env.SELFTEST_TOKEN);
  if (!selftestToken || url.searchParams.get("selftest") !== selftestToken) return json({ ok: false, error: "forbidden" }, 403);
  if (!env.BOOKVAULT_API_KEY) return json({ ok: false, error: "missing BOOKVAULT_API_KEY" });

  try {
    // The docs give the Basic header as `basic bv_KEY` (the key itself, not base64
    // user:pass). Some Basic servers instead want base64(key:""). We try the documented
    // form first; on 401 we retry the base64 form and report which one authenticated, so
    // the correct scheme is proven once, for free, before any order.
    const acct = await bvFetch(env, "/Account", "GET");
    let authForm = "documented";
    let ok = acct.ok;
    let body = acct.body;
    let status = acct.status;
    if (!acct.ok && acct.status === 401) {
      const alt = await bvFetch(env, "/Account", "GET", undefined, "base64");
      if (alt.ok) { authForm = "base64"; ok = true; body = alt.body; status = alt.status; }
      else status = alt.status;
    }

    const result = {
      ok, base: BV, authForm: ok ? authForm : null, httpStatus: status,
      account: ok && body ? {
        email: body.Email || null,
        name: [body.FirstName, body.LastName].filter(Boolean).join(" ") || null,
        setupComplete: body.Setup ? (body.Setup.Complete ?? null) : null,
        balance: body.Financial ? (body.Financial.Balance ?? body.Financial.Credit ?? null) : null,
        currency: body.Financial ? (body.Financial.CurrencyID || body.Financial.Currency || null) : null,
      } : null,
      error: ok ? undefined : (acct.raw || "").slice(0, 300),
    };
    if (!ok) return json(result);

    const authOverride = authForm === "base64" ? "base64" : undefined;
    const bookKey = url.searchParams.get("draft") || url.searchParams.get("validate");
    const testAddress = {
      Addressee: "Selftest Do Not Ship", Address1: "101 Independence Ave SE", Town: "Washington",
      County: "DC", Postcode: "20540", Country: { ISO_Code: "US" },
      TelNumber: str(env.FALLBACK_PHONE) || "+1 206 555 0100", Email: str(env.BOOKVAULT_CONTACT_EMAIL) || "customers@bookvault.app",
    };

    // ?getorder=<PodRef>: read one order back (read only).
    if (url.searchParams.get("getorder")) {
      const ref = url.searchParams.get("getorder");
      const d = await bvFetch(env, "/Order?PodRef=" + encodeURIComponent(ref), "GET", undefined, authOverride);
      return json({ ...result, getorder: { podRef: ref, ok: d.ok, status: d.status, order: d.body || null, error: d.ok ? undefined : (d.raw || "").slice(0, 300) } });
    }
    // ?cancel=<PodRef>: cancel/discard an order (operator cleanup).
    if (url.searchParams.get("cancel")) {
      const ref = url.searchParams.get("cancel");
      const d = await bvFetch(env, "/Order?PodRef=" + encodeURIComponent(ref), "DELETE", undefined, authOverride);
      return json({ ...result, cancel: { podRef: ref, ok: d.ok, status: d.status, error: d.ok ? undefined : (d.raw || "").slice(0, 300) } });
    }

    if (bookKey) {
      const book = BOOKS[bookKey];
      if (!book) return json({ ...result, error: "unknown book, use lockin or yourphone" });
      const isbn = str(env[book.isbnEnv]);
      if (!isbn) return json({ ...result, error: "missing " + book.isbnEnv });
      const orderBody = {
        DocRef: "selftest_" + Date.now(), OrderMethod: "API", Status: "Draft", Address: testAddress,
        DispatchRequest: { RequestedService: "CheapestTracked" },
        OrderLines: [{ ISBN: isbn, Quantity: 1 }], Notifications: { NotifyCustomer: false },
        ...customsFor("US"),
      };

      // ?validate=<book>: full validation, no payment, nothing created.
      if (url.searchParams.get("validate")) {
        const v = await bvFetch(env, "/ValidateOrder?type=FullButPayment", "POST", orderBody, authOverride);
        return json({ ...result, validate: { book: bookKey, ok: v.ok, status: v.status, criticalError: v.body ? v.body.CriticalError : null, lineErrors: (v.body && v.body.OrderLines || []).map((l) => l.ErrorCode), grandTotal: v.body && v.body.OrderCost ? v.body.OrderCost.GrandTotal : null, error: v.ok ? undefined : (v.raw || "").slice(0, 400) } });
      }

      // ?draft=<book>: create a FREE Draft to prove pricing end to end, then DELETE it.
      const d = await bvFetch(env, "/Order?payMethod=Draft", "POST", orderBody, authOverride);
      const podRef = d.ok && d.body && d.body.PodRef != null ? String(d.body.PodRef) : null;
      let deleted = null;
      if (podRef) { const del = await bvFetch(env, "/Order?PodRef=" + encodeURIComponent(podRef), "DELETE", undefined, authOverride); deleted = del.ok; }
      return json({
        ...result,
        draft: {
          book: bookKey, ok: d.ok, status: d.status, podRef,
          criticalError: d.body ? d.body.CriticalError : null,
          lineErrors: (d.body && d.body.OrderLines || []).map((l) => l.ErrorCode),
          grandTotal: d.body && d.body.OrderCost ? d.body.OrderCost.GrandTotal : null,
          currency: d.body ? detectOrderCurrency(d.body) : null,
          deletedDraft: deleted,
          error: d.ok ? undefined : (d.raw || "").slice(0, 400),
        },
      });
    }

    return json(result);
  } catch (e) {
    log("exception", String(e && e.message ? e.message : e));
    return json({ ok: false, error: "internal", message: String(e && e.message ? e.message : e).slice(0, 200) });
  }
}

// ---------------------------------------------------------------- helpers

// Bookvault HTTP Basic. Documented form is `Authorization: basic <bv_key>` (the key is the
// whole credential). The base64 form base64(key:"") is the standard Basic encoding and is
// offered as a fallback the self test can select. The key is never logged or returned.
function bvAuth(env, form) {
  const key = String(env.BOOKVAULT_API_KEY || "");
  if (form === "base64") return "Basic " + btoa(key + ":");
  return "basic " + key;
}

// One authenticated Bookvault call. Reads raw text then parses JSON in try/catch so an HTML
// error page or empty body cannot throw. Returns {ok, status, body, raw}.
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

// Gumroad pings are form encoded; fall back to parsing raw text as a query string.
async function parsePing(request) {
  try { return Object.fromEntries((await request.formData()).entries()); }
  catch (e) { try { return Object.fromEntries(new URLSearchParams(await request.text()).entries()); } catch (e2) { return null; } }
}

// Fetch one sale by id from Gumroad with our token. Any non success is "not found".
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

// Standard vs Express from Gumroad's human readable variant string. Only clearly express
// wording upgrades; anything else (including blank) is standard.
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

// Bookvault prints in the UK, so any non GB destination is an overseas shipment and
// Bookvault requires a customs declaration. Books are HS code 4901.99 (printed books).
// UseOrderValue lets Bookvault take the declared value from the order total, so we do not
// have to compute or send a price. DAP = customer is liable for any import duties (books
// are usually duty free under de minimis into US/CA/AU). Domestic GB orders need none.
function customsFor(country) {
  if (String(country).toUpperCase() === "GB") return {};
  return { CustomsDeclaration: { UseOrderValue: true, HSCode: "4901990000", IncoTerms: "DAP", UseIOSS: false } };
}

// Best effort read of the order's currency from the Bookvault order body. Falls back to
// null (which makes the margin check skip rather than assume USD).
function detectOrderCurrency(order) {
  const c = order && order.Partner && (order.Partner.CurrencyID || order.Partner.Currency);
  return c ? String(c).toUpperCase() : null;
}

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
