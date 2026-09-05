# BookVault print fulfilment via Gumroad (staged)

Sell paperbacks direct: Gumroad takes the money and the shipping address, a Cloudflare
Pages Function (`gumroad-bookvault.js`) catches the sale and tells BookVault to print and
ship straight to the buyer. No Payhip, no separate checkout.

## Proven working (2026-09-04, Lock In)
- Auth (`Authorization: basic bv_...`) OK, Master permissions.
- Lock In found: ISBN **9656946000010**, Active + Validated.
- US shipping quote OK: USPS Media Mail tracked, **$6.43**, 3 to 8 days, US printer.
- US print cost **$2.58**/copy. Landed cost ~**$9.01**/paperback. (UK £2.11, CA $2.74, AU $6.23.)
- `POST /Order` (billable) intentionally NOT fired.

## The one gotcha in the API
- Base URL `https://api.bookvault.app/v3`. Docs (ReDoc) at `/v3/docs`, spec at `/v3/swagger/docs/v3`.
- The documented `/ValidateOrder` route 404s in practice, so this function uses `/Dispatch`
  (shipping quote, non billable) for its DRY_RUN safety check and `/Order` to place live.

## Setup steps
1. **Cloudflare Pages, this project, Settings, Environment variables** (production). Add, NEVER commit:
   - `BOOKVAULT_API_KEY` = your bv_... key (mark Encrypted). Regenerate the one used for testing.
   - `GUMROAD_SELLER_ID` = your Gumroad seller id (from a ping or Gumroad settings).
   - `DRY_RUN` = `true` for now.
2. **Gumroad**: create a new PHYSICAL product "Lock In Paperback".
   - Product type: Physical (this makes Gumroad collect the shipping address).
   - Set the permalink to `lockinpaperback` (must match `PRODUCT_MAP` in the function).
   - Price it at your cover price (landed cost is ~$9, so ~$16.99 leaves a healthy margin).
   - Set shipping (a flat rate, or free and bake it into the price).
3. **Gumroad ping**: Settings, Advanced, Ping. Set the URL to
   `https://marcuscole.pages.dev/api/gumroad-bookvault`
4. **Deploy** this site (push to GitHub, Cloudflare rebuilds). The function goes live at that route.
5. **Test with DRY_RUN=true**: buy the paperback once (use a real card, refund after, or a 100% off
   code). The function will log the order it WOULD place plus a live shipping quote, and place nothing.
   Check Cloudflare, this project, Functions, Real time logs for the `[bv] DRY_RUN quote` line.
6. **Go live**: set `DRY_RUN=false`. From then on every paperback sale auto places a BookVault order.

## Current map (2026-09-05)
Both Marcus books are print-ready and approved on BookVault:
- Lock In = ISBN **9656946000010**
- Your Phone Owns You = ISBN **9656946000034** (122 pages, gutter fixed + re-approved)

`PRODUCT_MAP` now has three rows (see the function). Each needs a matching Gumroad
PHYSICAL product with the exact permalink:
- `lockinpaperback`       -> Lock In
- `yourphonepaperback`    -> Your Phone Owns You
- `marcuspaperbackbundle` -> BOTH books in one order (the bundle)

## To go live (5 min, needs you)
1. Gumroad: create the two missing PHYSICAL products with permalinks `yourphonepaperback`
   and `marcuspaperbackbundle` (Lock In Paperback already exists).
   Price ~$16.99 each, bundle ~$27.99. Turn ON "require shipping information".
2. Confirm the Gumroad ping URL is `https://marcuscole.pages.dev/api/gumroad-bookvault`.
3. Place ONE test paperback order with DRY_RUN=true and check Cloudflare Functions logs for
   the `[bv] DRY_RUN quote` line (proves the address + ISBN mapping works, no order placed).
4. Flip Cloudflare env `DRY_RUN=false`. From then, every paperback sale auto prints + ships.
5. Swap the site's "paperback coming soon" spans for the Gumroad buy buttons.

## Add more paperbacks later
Edit `PRODUCT_MAP` in `gumroad-bookvault.js`: one row per Gumroad physical product permalink ->
one or more BookVault ISBNs (bundle = more than one line). Redeploy.

## Notes / still to confirm on the first real order
- `Address.Country` is sent as an ISO code ("US"). If BookVault rejects it on the first live
  order, the API may want the country object or numeric id (see `/Countries`); adjust `isoCountry`.
- `ShippingLevel: CheapestTracked` picks the cheapest tracked service. Change per taste.
- Consider verifying the Gumroad ping more strictly (Gumroad does not sign pings; seller_id check
  plus keeping this URL private is the practical guard).
