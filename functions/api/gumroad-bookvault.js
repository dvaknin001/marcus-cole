// Cloudflare Pages Function: Gumroad sale ping -> BookVault print order
// Route: POST https://marcuscole.pages.dev/api/gumroad-bookvault
//
// Flow: a customer buys a PHYSICAL (paperback) product on Gumroad. Gumroad collects
// payment and the shipping address, then POSTs a "ping" to this URL. We map the
// product to a BookVault ISBN and place a print on demand order that BookVault
// prints and ships straight to the buyer.
//
// SECRETS (set in Cloudflare Pages, Settings, Environment variables, NEVER in the repo):
//   BOOKVAULT_API_KEY   the bv_... key (mark as Encrypted)
//   GUMROAD_SELLER_ID   your Gumroad seller id, to verify the ping is really yours
//   DRY_RUN             "true" (default) = quote only via /Dispatch, no billable order.
//                       Set to "false" only when you are ready to place real orders.
//
// Product to book mapping. Add a row per paperback you sell. The key is the Gumroad
// product permalink (the slug in dvpress.gumroad.com/l/<permalink>). "lines" lists the
// BookVault ISBNs to print for that product; a bundle simply lists more than one.
const PRODUCT_MAP = {
  lockinpaperback:        { title: "Lock In",              lines: [{ isbn: "9656946000010", qty: 1 }] },
  yourphonepaperback:     { title: "Your Phone Owns You",  lines: [{ isbn: "9656946000034", qty: 1 }] },
  marcuspaperbackbundle:  { title: "Marcus Cole Bundle",   lines: [{ isbn: "9656946000010", qty: 1 }, { isbn: "9656946000034", qty: 1 }] },
};

const BV = "https://api.bookvault.app/v3";

export async function onRequestPost(context) {
  const { request, env } = context;
  const log = (...a) => console.log("[bv]", ...a);

  // Gumroad pings are form encoded
  let p;
  try {
    const form = await request.formData();
    p = Object.fromEntries(form.entries());
  } catch (e) {
    return json({ ok: false, error: "bad body" }, 400);
  }

  // 1. verify the ping is from our own Gumroad account
  if (env.GUMROAD_SELLER_ID && p.seller_id && p.seller_id !== env.GUMROAD_SELLER_ID) {
    log("seller mismatch", p.seller_id);
    return json({ ok: false, error: "seller mismatch" }, 403);
  }

  // 2. map the purchased product to a BookVault title
  const permalink = (p.permalink || p.product_permalink || "").toLowerCase();
  const book = PRODUCT_MAP[permalink];
  if (!book) {
    log("no mapping for", permalink, "(ignored, likely a digital product)");
    return json({ ok: true, ignored: true }); // not a paperback we fulfil
  }

  // 3. build the BookVault order from Gumroad shipping fields
  const qty = parseInt(p.quantity || "1", 10) || 1;
  const country = isoCountry(p.country || p.shipping_country || "US");
  // one product may print several ISBNs (a bundle); multiply each line by the qty bought
  const orderLines = book.lines.map((l) => ({ ISBN: l.isbn, Quantity: (l.qty || 1) * qty }));
  const order = {
    CustRef: p.sale_id || p.order_number || ("GUM-" + Date.now()),
    OrderMethod: "API",
    ProductionLevel: "Standard",
    Address: {
      Addressee: p.full_name || p.purchaser_name || "Customer",
      Address1: p.street_address || p.address1 || "",
      Address2: p.address2 || "",
      Town: p.city || "",
      County: p.state || p.county || "",
      Postcode: p.zip_code || p.postal_code || p.zip || "",
      Country: country,
      Email: p.email || "",
      TelNumber: p.phone || "",
      ShippingLevel: "CheapestTracked",
    },
    OrderLines: orderLines,
  };

  const auth = { Authorization: "basic " + env.BOOKVAULT_API_KEY, "Content-Type": "application/json" };
  const dryRun = String(env.DRY_RUN ?? "true") !== "false";

  if (dryRun) {
    // safe: shipping quote only, never places a billable order
    const q = await fetch(BV + "/Dispatch", {
      method: "POST", headers: auth,
      body: JSON.stringify({ OrderLines: order.OrderLines, CountryCode: country, ServiceLevel: "Cheapest", Currency: "USD" }),
    });
    const quote = await q.json().catch(() => ({}));
    log("DRY_RUN quote", book.title, "->", q.status);
    return json({ ok: true, dryRun: true, wouldOrder: order, quote });
  }

  // live: place the print order (BILLABLE, prints and ships)
  const r = await fetch(BV + "/Order", { method: "POST", headers: auth, body: JSON.stringify(order) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.CriticalError) {
    log("ORDER FAILED", r.status, JSON.stringify(body).slice(0, 300));
    return json({ ok: false, status: r.status, bookvault: body }, 502);
  }
  log("ORDER PLACED", book.title, "ref", body.PodRef, "cust", order.CustRef);
  return json({ ok: true, podRef: body.PodRef, custRef: order.CustRef });
}

function isoCountry(c) {
  const s = String(c).trim().toUpperCase();
  const m = { "UNITED STATES": "US", USA: "US", "UNITED KINGDOM": "GB", UK: "GB", CANADA: "CA", AUSTRALIA: "AU" };
  return m[s] || (s.length === 2 ? s : "US");
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
