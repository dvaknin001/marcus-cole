# Status — Marcus Cole site: Bookvault fulfilment integration
_Last updated: 2026-09-14 10:30_

## Objective
Add Book Vault print-on-demand fulfilment to the marcuscole.pages.dev store so Marcus Cole
paperbacks (Lock In, Your Phone Owns You) are printed and shipped by Book Vault instead of
Lulu. Reason for the switch: Book Vault print is roughly half Lulu's cost. Payment is still
collected by Gumroad; on a paid sale Gumroad pings a Cloudflare Pages function which places
the Book Vault order. No Lulu fallback wanted (Lulu is ~2x the print price).

## Where the work lives
- Repo: **github.com/dvaknin001/marcus-cole**, branch **main**. Cloudflare Pages project
  **marcuscole** auto-deploys on every push to main (no build step; `pages_build_output_dir = "."`).
- This session worked in a TEMP clone at
  `C:\Users\kingv\AppData\Local\Temp\claude\...\scratchpad\marcus-cole` (will be deleted).
  Everything is committed AND pushed to GitHub, so to resume: `git clone` the repo fresh.
- Book Vault OpenAPI spec (Swagger 2.0) saved at `...\scratchpad\bv_spec.json`; re-fetch anytime
  from https://api.bookvault.app/v3/swagger/docs/v3 . Docs (ReDoc): https://api.bookvault.app/v3/docs

## Current state
- **Done + deployed:** `functions/api/bookvault.js` — the Book Vault twin of the existing
  `functions/api/gumroad-lulu.js`. Flow: untrusted Gumroad ping → re-fetch the real sale from
  Gumroad with our token → map product to a Book Vault title by ISBN → POST /Order?payMethod=Draft
  (FREE) to price + validate → margin check → when DRY_RUN=false, delete the draft and place the
  real order (POST /Order?payMethod=Saved, Status Active, charged to the saved card). Idempotency
  + failure notes in the existing ORDERS KV under `bvorder:`/`bvfail:` prefixes. Customs
  declaration auto-added for non-GB destinations (HS 4901.99 books). Countries: US, CA, GB, AU.
- **Verified working (free self-test):** GET /Account returns ok (auth form = documented
  `basic bv_<key>`). A US-address draft returns `ok:true, grandTotal 9.95, currency "GBP",
  criticalError false, lineErrors ["OK"], deletedDraft true`. So auth, ISBN resolution, customs,
  pricing and draft/delete all work end to end.
- **In progress / pending:** (1) Fable 5.1 is reviewing bookvault.js against the Book Vault API
  spec — findings not yet applied. (2) The margin check is currently SKIPPED when the order is
  priced in a non-USD currency (see Dead ends) — a live GBP-priced order could ship at a loss;
  needs a fix before go-live.
- **Not started:** flipping DRY_RUN=false; repointing the Gumroad product ping URLs to
  /api/bookvault; deleting the old Lulu function/secrets.

## Files touched (in the marcus-cole repo)
- `functions/api/bookvault.js` — NEW, the whole integration (~330 lines). Deployed.
- `wrangler.toml` — documented the new ORDERS KV keys (`bvorder:` / `bvfail:`). No new bindings.
- `status.md` — this file.

## Cloudflare secrets (marcuscole project, set by Dean — SET and confirmed working)
- `BOOKVAULT_API_KEY` = the bv_ key. `BOOKVAULT_ISBN_LOCKIN` = 9656946000010.
  `BOOKVAULT_ISBN_YOURPHONE` = 9656946000034 (NOTE a stray duplicate library title
  9656946000027 "IMAGE COMING SOON" exists — do not order that one).
- Shared with Lulu (already set): GUMROAD_API_TOKEN, GUMROAD_SELLER_ID, FALLBACK_PHONE,
  SELFTEST_TOKEN (was reset this session to the value Dean set (in Cloudflare; not stored here)), DRY_RUN (currently NOT "false").
- Optional: `BOOKVAULT_PAY_METHOD` (default "Saved" = saved card per order; "Credit" = prepaid
  balance). `BOOKVAULT_CONTACT_EMAIL`.
- Lulu-only secrets (LULU_*, ASSET_TOKEN) are safe to delete once fully off Lulu.

## Next action
Apply the Fable 5.1 review findings to `functions/api/bookvault.js` (await its report), then
resolve the currency/margin gap (below). Do NOT flip DRY_RUN to false until both are done and a
real US test order confirms it prints+ships from a US facility.

## How to test (all free, nothing billable)
Self-test URLs (replace token if SELFTEST_TOKEN changed):
- Key + account:   `https://marcuscole.pages.dev/api/bookvault?selftest=<SELFTEST_TOKEN>`
- Price a draft:   `...&draft=lockin`  (and `&draft=yourphone`) — creates a free draft, returns
  grandTotal + currency, auto-deletes it.
- Read an order:   `...&getorder=<PodRef>` ; cancel: `...&cancel=<PodRef>`
The only true test that it PRINTS + charges is one real order (DRY_RUN=false), which costs money.

## Dead ends / open questions
- **Currency is GBP, not USD.** The draft to a US address priced £9.95. Currency is set by the
  print PARTNER; the account default is the UK facility (GBP). `POST /GlobalAv` with just {ISBN}
  returned `null` (no alternate partners listed), so a US partner could not be selected via API.
  Dean believes Book Vault AUTO-ROUTES to a US print+ship facility based on the delivery address
  (so the GBP may just be the account base-currency estimate, and a real US order may actually
  print/ship domestically in the US). UNVERIFIED — the way to confirm is a real US order and see
  where it ships from / what the card is charged. A `?partners=` debug probe was added then
  REVERTED (commit history) because GlobalAv returned null and Dean changed a BV account setting.
- **£9.95 ≈ $12.60 to print+ship one book from the UK is more than the retail price** — US sales
  fulfilled from the UK lose money. This is the whole reason the US-routing question matters.

## Open decisions (waiting on Dean)
1. Confirm Book Vault US auto-routing via a real US test order before go-live.
2. Whether to add a GBP→USD FX conversion to the margin check now (so a live order can't ship at
   a loss while currency is GBP), or rely on US routing making it USD. Recommendation: add the FX
   safety conversion regardless — cheap insurance.
3. Go-live steps when ready: set DRY_RUN=false; repoint Gumroad product ping URLs from
   /api/gumroad-lulu to /api/bookvault.

## Gotchas
- Book Vault auth is `Authorization: basic bv_<KEY>` (the key IS the credential, not base64
  user:pass). The self-test auto-falls back to base64 and reports which worked; live path uses
  the documented form. Confirmed "documented" works.
- Book Vault field casing is PascalCase (DocRef, OrderLines, Address.Address1, Country.ISO_Code,
  DispatchRequest.RequestedService). ISO2 for the UK is "GB", not "UK".
- Cloudflare Pages: git push auto-rebuilds; direct `wrangler pages deploy` gets reverted by the
  git build. Always commit to make changes stick. Encrypted secrets are not viewable after save;
  to "read" one you must overwrite it (that's why SELFTEST_TOKEN was reset).
- The temp clone is disposable — the source of truth is GitHub. Re-clone to resume.
