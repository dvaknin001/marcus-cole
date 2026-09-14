# Status — Marcus Cole site: Book Vault fulfilment (finishing Gumroad go-live)
_Last updated: 2026-09-14 13:00_

## Objective
Sell Marcus Cole paperbacks (Lock In, Your Phone Owns You, and the two-book bundle) on
marcuscole.pages.dev. Payment is collected by **Gumroad**; on each paid sale Gumroad pings a
Cloudflare Pages function that places a print-on-demand order with **Book Vault**, which
prints and ships to the buyer. Ebooks stay as instant Gumroad downloads. Decision (2026-09-14):
**finish on Gumroad**, do NOT build a direct Stripe/PayPal checkout right now (possible future
upgrade; Dean has Stripe + PayPal but is not using them here). Do NOT port anything from Claire.

## Where the work lives (IMPORTANT)
- Repo: **github.com/dvaknin001/marcus-cole**, branch **main**. Everything below is committed +
  pushed. Cloudflare Pages project **marcuscole** auto-deploys on every push to main (no build
  step). To resume, work from a fresh clone of that repo (a persistent clone was placed at
  C:\Users\kingv\OneDrive\Desktop\marcus-cole — pull latest before editing).
- The prior session worked in a temp clone (now gone). GitHub is the source of truth.
- Book Vault API spec (Swagger 2.0): refetch from https://api.bookvault.app/v3/swagger/docs/v3
  (docs UI https://api.bookvault.app/v3/docs). Auth = HTTP Basic, header `Authorization: basic bv_<KEY>`.

## Current state — EVERYTHING CODE-SIDE IS DONE + DEPLOYED
- `functions/api/gumroad-bookvault.js` — fulfilment webhook. Flow: untrusted Gumroad ping →
  re-fetch the real sale from Gumroad with our token → map product to a Book Vault title by ISBN →
  POST /Order?payMethod=Draft (FREE) to price+validate → margin check (converts GBP→USD via
  FX_GBP_USD, fails CLOSED if currency unverifiable) → when DRY_RUN=false, delete the draft and
  place the real order (POST /Order?payMethod=Saved, charges the saved card). Idempotency +
  failure notes in ORDERS KV under bvorder:/bvfail:. Customs declaration auto-added for non-GB.
  Tier: Express→"Quickest", Standard→"CheapestTracked". Countries: US, CA, GB. Fable 5.1 reviewed
  it; all findings applied.
- `checkout.js` + the 3 pages (index.html, lockin/index.html, your-phone-owns-you/index.html) —
  on-site checkout-style modal: "Get the Paperback" opens a popup with cover, order line,
  Standard/Express radios, a live Total, and "Continue to secure checkout" → opens the matching
  Gumroad version via ?variant=Standard%20Shipping / Express%20Shipping &wanted=true. Ebook kept as
  a small secondary link. Top banner: ships to UK, USA, Canada; ebook worldwide. (The modal close
  X/Esc/backdrop bug is fixed.)
- Gumroad side (verified in dashboard 2026-09-14): all 3 paperback products have two VERSIONS named
  exactly "Standard Shipping" / "Express Shipping", priced correctly (Lock In $18.98/$27.99, Your
  Phone $21.98/$28.98, Bundle $22.48/$29.98), and "Require shipping information" is ON. Gumroad
  records the chosen version per sale (sale.variants), which detectTier() reads.
- **Gumroad Ping endpoint is already set** to `https://marcuscole.pages.dev/api/gumroad-bookvault`
  (Settings → Advanced). The function route matches it. Gumroad seller_id = `db_l0-7fJGWG6oMV0ar1-Q==`.

## Cloudflare secrets (marcuscole project — Dean sets these; encrypted, not viewable)
Confirmed working via self-test: BOOKVAULT_API_KEY, BOOKVAULT_ISBN_LOCKIN=9656946000010,
BOOKVAULT_ISBN_YOURPHONE=9656946000034, BOOKVAULT_ISBN_MC_BUNDLE (bundle title ISBN, set by Dean),
SELFTEST_TOKEN. Needed for the POST path: GUMROAD_API_TOKEN, GUMROAD_SELLER_ID
(= db_l0-7fJGWG6oMV0ar1-Q==), FALLBACK_PHONE, DRY_RUN. Optional: BOOKVAULT_PAY_METHOD (default
"Saved" = saved card per order; "Credit" = prepaid balance), FX_GBP_USD (default 1.45),
BOOKVAULT_CONTACT_EMAIL. Note: a stray duplicate Book Vault title 9656946000027 "IMAGE COMING SOON"
exists — do not order it.

## Next action — the ONLY thing left is the live paid test
1. Confirm GUMROAD_API_TOKEN + GUMROAD_SELLER_ID + BOOKVAULT_ISBN_MC_BUNDLE are set (else sales park).
2. Set `DRY_RUN=false` in Cloudflare, redeploy.
3. Buy ONE paperback through the site's "Get the Paperback" → Express (REAL money: Dean pays Gumroad
   ~$28 less ~10% fee back to himself; Book Vault later charges the saved card ~$13 to print+ship; a
   real book ships in ~2-3 weeks). Cannot use a 100%-off code — a $0 net fails the margin check and
   parks with no Book Vault order.
4. Verify: `https://marcuscole.pages.dev/api/gumroad-bookvault?selftest=<SELFTEST_TOKEN>&getorder=<PodRef>`
   (PodRef from Cloudflare Pages function logs, line "ORDER PLACED"), or the Book Vault portal.
   Confirm the dispatch came through as express.
5. Set `DRY_RUN` back to `true` unless staying live.

## How to test for FREE (no money; proves everything except a real charge)
`https://marcuscole.pages.dev/api/gumroad-bookvault?selftest=<SELFTEST_TOKEN>` → account + saved card.
Add `&draft=lockin` / `&draft=yourphone` / `&draft=bundle` → prices a real Book Vault draft (cost,
currency, delivery days), then deletes it. All confirmed working.

## Dead ends / open question
- **Draft prices in GBP (£), not USD.** Book Vault's account default is the UK print facility.
  UNVERIFIED whether US orders auto-route to a US facility (cheaper/faster/no customs) by delivery
  address. The live paid test (step 3) reveals where it actually prints/ships and the card charge.
  `POST /GlobalAv` with just {ISBN} returned null, so a US partner could not be picked via API as
  the account is configured.
- **~£9.95 print+ship from the UK is more than the book's price** — if US orders truly ship from the
  UK, the economics do not work and US routing must be sorted with Book Vault before scaling.
- Do NOT collect card/payment on our own site (prohibited + PCI). Payment stays on Gumroad.

## Gotchas
- Function route = filename: `functions/api/gumroad-bookvault.js` → `/api/gumroad-bookvault` (matches
  the Gumroad Ping). Self-test is a GET on that same route.
- Book Vault auth is literally `Authorization: basic bv_<KEY>` (key IS the credential). Self-test
  falls back to base64 and reports which worked; live path uses the documented form (confirmed).
- Book Vault field casing is PascalCase; UK ISO2 = "GB". Version names must stay exactly
  "Standard Shipping" / "Express Shipping" (site ?variant= links + detectTier depend on them).
- Cloudflare Pages: commit to git to deploy; `wrangler pages deploy` gets reverted by the git build.
  Encrypted secrets aren't viewable after save; to change one, overwrite it.
- No hyphens/dashes in customer-facing copy (house rule); use commas, "and", or a middot.
