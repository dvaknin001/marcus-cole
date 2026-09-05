// TEMPORARY diagnostic: read-only, FREE Lulu calls to capture cover dimensions and
// print cost for the two Marcus Cole paperbacks. No orders are created, nothing is
// charged. Token gated so a random passerby cannot spam it. DELETE after use.
//
// Route: GET https://marcuscole.pages.dev/api/lulu-diag?k=<TOKEN>
// Secrets used (already set in Cloudflare Pages): LULU_CLIENT_KEY, LULU_CLIENT_SECRET,
//   LULU_ENV (=production). We never echo any secret.

const TOKEN = "cc857a6b7fe03c6b62d27b54376e9c95";

const BOOKS = [
  { title: "Lock In",             pod: "0550X0850.BW.STD.PB.060UW444.MXX", pages: 102 },
  { title: "Your Phone Owns You", pod: "0600X0900.BW.STD.PB.060UW444.MXX", pages: 122 },
];

// A generic public US address (Library of Congress) just so cost-calc returns a quote.
const SHIP_ADDR = {
  city: "Washington", country_code: "US", postcode: "20540",
  state_code: "DC", street1: "101 Independence Ave SE", phone_number: "+1 206 555 0100",
};
const SHIP_OPTIONS = ["MAIL", "GROUND", "EXPEDITED", "EXPRESS"];

function base(env) {
  return String(env.LULU_ENV) === "production" ? "https://api.lulu.com" : "https://api.sandbox.lulu.com";
}

async function token(env) {
  const b = base(env);
  const basic = btoa(env.LULU_CLIENT_KEY + ":" + env.LULU_CLIENT_SECRET);
  const r = await fetch(b + "/auth/realms/glasstree/protocol/openid-connect/token", {
    method: "POST",
    headers: { Authorization: "Basic " + basic, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error("auth " + r.status + " " + JSON.stringify(j).slice(0, 200));
  return j.access_token;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  if (url.searchParams.get("k") !== TOKEN) return json({ error: "forbidden" }, 403);
  if (!env.LULU_CLIENT_KEY || !env.LULU_CLIENT_SECRET) return json({ error: "no lulu keys" }, 500);

  const out = { env: String(env.LULU_ENV || "unset"), books: [] };
  try {
    const t = await token(env);
    const b = base(env);
    const auth = { Authorization: "Bearer " + t, "Content-Type": "application/json", Accept: "application/json" };

    for (const bk of BOOKS) {
      const row = { title: bk.title, pod: bk.pod, pages: bk.pages };

      // ---- cover dimensions (full wrap incl bleed + spine), in points -> convert to inches
      const cd = await fetch(b + "/cover-dimensions/", {
        method: "POST", headers: auth,
        body: JSON.stringify({ pod_package_id: bk.pod, interior_page_count: bk.pages }),
      });
      const cdj = await cd.json().catch(() => ({}));
      if (cd.ok && cdj.width) {
        const toIn = (v) => Math.round((Number(v) / 72) * 1000) / 1000;
        row.cover = { unit: cdj.unit, width_pt: cdj.width, height_pt: cdj.height, width_in: toIn(cdj.width), height_in: toIn(cdj.height) };
      } else {
        row.cover = { error: cd.status, body: JSON.stringify(cdj).slice(0, 300) };
      }

      // ---- print + shipping cost for qty 1 to a US address, per shipping option
      row.cost = {};
      for (const opt of SHIP_OPTIONS) {
        const cc = await fetch(b + "/print-job-cost-calculations/", {
          method: "POST", headers: auth,
          body: JSON.stringify({
            line_items: [{ page_count: bk.pages, pod_package_id: bk.pod, quantity: 1 }],
            shipping_address: SHIP_ADDR,
            shipping_option: opt,
          }),
        });
        const ccj = await cc.json().catch(() => ({}));
        if (cc.ok) {
          row.cost[opt] = {
            line: ccj.line_item_costs?.[0]?.total_cost_excl_tax ?? null,
            shipping: ccj.shipping_cost?.total_cost_excl_tax ?? null,
            total_excl_tax: ccj.total_cost_excl_tax ?? null,
            total_incl_tax: ccj.total_cost_incl_tax ?? null,
            currency: ccj.currency ?? null,
          };
        } else {
          row.cost[opt] = { error: cc.status, body: JSON.stringify(ccj).slice(0, 200) };
        }
      }

      out.books.push(row);
    }
  } catch (e) {
    out.error = String(e && e.message ? e.message : e);
  }
  return json(out);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), { status, headers: { "Content-Type": "application/json" } });
}
