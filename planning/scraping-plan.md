# Scraping Plan: Palatine Library (BiblioCommons)

Findings come from inspecting a logged-in session at `https://palatinelibrary.bibliocommons.com` in Chrome.
Each finding is marked **[verified]** (observed working) or **[inferred]** (read from the JS bundle or the login HTML, not exercised).

## Summary

- There is no public API. BiblioCommons does have an undocumented JSON gateway, `gateway.bibliocommons.com/v2/libraries/palatinelibrary/...`, which the site's own SPA uses. It returns clean JSON, so **no HTML scraping is needed**.
- The gateway authenticates with session cookies. A cookie-less request returns `401` **[verified]**. The cookies are HttpOnly, so they can't be read from page JS and have to be obtained by logging in.
- Each user's account is identified by an `accountId`. The app needs it for every call, and it can be read from the page's embedded state after login.
- Plan: log in programmatically with plain HTTP (form POST + CSRF token), keep the cookie jar per registered account, and call the gateway directly. Fall back to headless-browser login only if plain HTTP login is blocked.

## Data endpoints

Base: `https://gateway.bibliocommons.com/v2/libraries/palatinelibrary`

All requests need the session cookies (`credentials: include` in a browser, a cookie jar in server code).

### 1. Checked-out items **[verified]**

```
GET {base}/checkouts?accountId={accountId}&materialType=PHYSICAL&page=1&size=100
```

- Response top-level keys: `entities`, `borrowing`.
- `borrowing.checkouts` has pagination: `{count, page, limit, pages}`. Loop over pages if `pages > 1`.
- Per-checkout data is in `entities.checkouts[<id>]`:
  `checkoutId`, `metadataId`, `dueDate` (`YYYY-MM-DD`), `status` (e.g. `OUT`), `timesRenewed`, `fines`, `actions` (array containing `"renew"` when the item can be renewed), `branch`, `materialType`, `bibTitle`.
- Titles and authors are in `entities.bibs[<metadataId>].briefInfo` (`title`, `subtitle`, `authors`, `format`, ...). Join on `metadataId`.
- Digital (OverDrive) items use the same endpoint with a different `materialType`. The account's quota shows `OverDriveAPI` entries. This is out of scope for v1, but a second call with `materialType=DIGITAL` is the likely approach **[inferred]**.
- `actions` is the signal for renewability. Don't attempt a renewal when `"renew"` is absent.

### 2. Fees **[verified]**

```
GET {base}/fines?accountId={accountId}
```

- Response: `borrowing.fines.results[]` (itemized, paginated with `size`/`totalElements`/`totalPages`) and `borrowing.summaries.fines` = `{totalAccrued, totalFines, totalCredits}`.
- Use `borrowing.summaries.fines.totalFines` for the "fees due" figure (observed: `{"totalAccrued": 0, "totalCredits": 0, "totalFines": 4.99}`).
- **[verified, account with a fee]** Itemized fees: `borrowing.fines.results` is a list of fine ids, and the rows are in `entities.fines[<id>]`:

  ```json
  {
    "id": "<fine id>", "billId": "4887617", "status": "UNPAID", "payable": true,
    "amount": 4.99, "description": "Replacement Cost",
    "bibTitle": "Debbie the Duckling Fairy", "bibSubtitle": "", "metadataId": "S202C1115798",
    "checkedOutDate": "2026-05-05", "dueDate": "2026-05-29",
    "renewedDate": null, "returnedDate": null, "message": "", "messageDate": null
  }
  ```

  Pagination: `borrowing.fines.pagination` = `{number, size: 25, totalElements, totalPages}` (page numbers are 0-based). Request more pages if `totalPages > 1`. Unlike checkouts, no `bibs` entities came back, so the title is in `bibTitle`.
- Observed `description` value: `Replacement Cost` (a lost-item charge). Overdue-fine rows, which probably use `totalAccrued` for still-accruing amounts, were not seen. Show `status`/`payable` and don't assume the description set is closed.
- The app only reads fees. Paying is out of scope (and needs card details).
- Per-item fines also appear on each checkout as `fines` (number).

### 3. Renew **[verified: renewed "Ember Rising" on 2026-11-24]**

Single or multiple items:

```
PATCH {base}/checkouts?locale=en-US
Content-Type: application/json
{ "accountId": <accountId>, "checkoutIds": ["<checkoutId>"], "renew": true }
```

(`accountId` is a number; `checkoutIds` are strings. The example IDs are from the test account. `messagingId` is optional and was not sent by the page.)

Observed response (HTTP 200):

```json
{
  "borrowing": { "checkouts": { "items": ["<checkoutId>"] } },
  "entities": { "checkouts": { "<checkoutId>": { "dueDate": "2026-12-15", "timesRenewed": 3, "actions": ["renew","updateFormat"], "status": "OUT", ... } } },
  "failures": []
}
```

- The result: the due date moved from 2026-12-03 to 2026-12-15 and `timesRenewed` went from 2 to 3.
- Success = the id is in `entities.checkouts` with the new `dueDate` and not in `failures`. Treat a non-empty `failures` array as a per-item failure. Its entry shape is **unknown**, because nothing failed. Log the raw JSON the first time one appears.
- The renewed item still lists `"renew"` in `actions` after the third renewal. `actions` does not reflect the renewal limit, so the app must handle a failure on renew (e.g. renewal limit reached, or the item has a hold) instead of relying on `actions`.
- **[verified with curl]** The renew call works from plain HTTP with only the session cookie jar, a `User-Agent` and `Content-Type: application/json`. No `Origin`, `Referer` or CSRF header is needed.
- **[verified] A failed renewal is still `HTTP 200`.** Check `failures`, never the status code alone. Observed (Ember's End, already renewed twice, on a second account):

  ```json
  {
    "borrowing": { "checkouts": { "items": [] } },
    "entities": { "checkouts": {} },
    "failures": [{
      "providerType": "ILS",
      "id": "<checkoutId>",
      "itemId": null,
      "metadataId": null,
      "errorResponseDTO": {
        "fieldErrors": {},
        "message": "Item has exceeded renewal limit, not allowed to renew",
        "classification": "RenewFailed"
      }
    }]
  }
  ```

  - On failure the item is absent from `entities.checkouts` and `borrowing.checkouts.items` is empty, so the due date and `timesRenewed` are unchanged. A follow-up `GET /checkouts` confirmed that.
  - Match failures to the request by `failures[].id` (== the checkout id). With several `checkoutIds` in one request, expect successes in `entities.checkouts` and failures in `failures` side by side. This mixed case is **not yet observed**.
  - Expose `errorResponseDTO.message` to the user and use `classification` (`RenewFailed` so far) for logic. Other classifications (e.g. item on hold) have not been seen, so treat unknown ones as a generic failure.
- **The renewal limit varies per item.** Ember's End failed at 2 renewals, while Ember Rising succeeded for a 3rd renewal. The `renew` entry in `actions` is present in both cases, so the app can't predict the limit and must treat "renew" as best-effort: attempt it, then report the per-item result.

"Renew all" (what the page's quick-renew button does):

```
PATCH {base}/checkouts/renewal?accountId=...&status=OUT&materialType=PHYSICAL&size=...&sort=...
```

- "Renew all" (`/checkouts/renewal`) was not exercised. Its verb and body are inferred from the bundle only. Prefer the verified `PATCH /checkouts` with explicit `checkoutIds`, which also gives per-item control.
- **Still unverified:** the `failures` entry shape and renewal-limit error codes. Renewing is non-undoable and uses up a renewal, so only test this on an item the user has agreed to.
- After renewing, re-fetch `/checkouts` to refresh the cache.

### 4. Other observations

- The page `/v2/checkedout/out` is server-rendered. Its state is embedded as a ~260 KB `<script type="application/json">` blob (also on `window.__staticRouterHydrationData`), including `entities.checkouts`, `entities.accounts`, and `borrowing.summaries`. It is a handy fallback and the place to read `accountId` (`entities.accounts[*].id`). It is not needed for normal polling.
- `borrowing.summaries.checkedout.nextDue` gives the earliest due date and `total`, a cheap overview.

## Authentication

### Observed **[verified]**

- Session cookies: `remember_me`, `uniq_id`, `agency_id`, `branch`, `origin_domain`, plus the HttpOnly auth cookies (not visible to JS) that the gateway accepts.
- `remember_me` suggests a long-lived "remember me" session, so a stored session can last a long time. Its real lifetime is unmeasured.
- A cookie-less call to the gateway returns `401`, so cookies alone are sufficient for GETs (no bearer-token header needed).

### Login form **[inferred from fetched HTML, not submitted]**

`GET https://palatinelibrary.bibliocommons.com/user/login` returns a Rails-style form:

| Field | Notes |
|---|---|
| `authenticity_token` | hidden CSRF token; also in `<meta name="csrf-token">`. Must be sent along with the cookie from the GET. |
| `name` | library card number or username |
| `user_pin` | PIN or password |
| `remember_me` | checkbox, `true`. Send it to get the long-lived cookie. |
| `local` | hidden, `false` |
| `commit` | `Log In` |

- No reCAPTCHA, hCaptcha or Turnstile was found in the login HTML, and a real browser login with the user typing credentials succeeded with no challenge.
- **[verified]** Form: `method="post"`, `action` = `https://palatinelibrary.bibliocommons.com/user/login?destination=<url-encoded path>`. The urlencoded fields are `utf8`, `authenticity_token`, `name`, `user_pin`, `remember_me`, `local`, `commit`.
- **[verified]** A real login (with `remember_me` checked) ended on `/user_dashboard` with the login URL as referrer, i.e. a successful POST redirects to `destination` (here `/user_dashboard`), and the session cookies are then set. After that the dashboard page calls `/user_stats/borrowing?section=…` and `/user/<userId>/…` (these are the library's own page fragments, and not needed for this app).
- **[verified]** After login, the visible cookie `remember_me` expires about 13 months out (2027-12-29 from a 2026-11-24 login). The other visible cookies (`agency_id`, `view`, `uniq_id`, `origin_domain`, `elapsed_time`) are session cookies. The HttpOnly auth cookies stay invisible to the browser tooling, so their names and lifetimes are unconfirmed. Assume the effective session can be re-established from `remember_me`, but still keep the stored credentials as a fallback.
- **[verified with curl, fake account]** Plain-HTTP flow works without a browser:
  1. `GET /user/login` returns a `302` to `/user/login?destination=%2Fuser_dashboard`. Follow redirects (`-L`). It sets the cookies `agency_id`, `language`, `view`, `uniq_id`, `elapsed_time` and an HttpOnly `SRV` (load-balancer affinity, domain `.bibliocommons.com`). The CSRF token is in `<meta name="csrf-token" content="…">` (44 chars) and is also the hidden `authenticity_token` field.
  2. `POST` to the form's `action` with the urlencoded fields. A plain `curl` with a browser-like `User-Agent` and `Origin`/`Referer` is accepted, with no JS or CAPTCHA involved.
  3. **Failed login** returns `HTTP 200` with the login page again (no redirect, no `Location`). The failure text is embedded in the page JSON as `"The username or PIN is incorrect. Please try again"` with `"type":"error"`. The server also sets `remember_me`, a refreshed `elapsed_time`, and the HttpOnly `_live_bcui_session_id` (domain `.bibliocommons.com`) even on a failed attempt, so cookies appearing does **not** mean success.
  4. A POST without a valid CSRF token also returns `HTTP 200` but with a different generic message ("An error occurred and your request could not be completed. Please try again later"), so the two failures can be told apart.
  - `remember_me` on that response expires **10 years** out (`2036`), and the browser showed ~13 months after the real login. The real expiry may differ after a successful login, so trust the cookie jar rather than these numbers.
- Success detection: a failed login returns 200 too, so don't rely on the status code. Treat the login as successful only if the follow-up `GET /v2/checkedout/out` stays on that URL (not redirected to `/user/login`) and the gateway `/checkouts` call returns 200 with the jar.
- **[verified with curl, real account]** [scripts/probe-login.sh](scripts/probe-login.sh) (prompts for credentials silently; prints only cookie names/flags/expiry):
  - **Successful login = `HTTP 302`** with `Location: https://palatinelibrary.bibliocommons.com/user_dashboard` (the form's `destination`). A failed login is a `200` (see above), so the status code alone separates the two: `302` means success, `200` means failure.
  - The success response sets the auth cookies **`session_id`** and **`bc_access_token`** (both HttpOnly, domain `.bibliocommons.com`, **session cookies with no expiry**), plus `_live_bcui_session_id` and `SRV` (HttpOnly), `origin_domain`, `remember_me`, and several preference cookies.
  - **Cookie scoping:** the auth cookies are on `.bibliocommons.com`, so the jar must send them to both `palatinelibrary.bibliocommons.com` and `gateway.bibliocommons.com`. A standard cookie jar (`curl -c/-b`, `tough-cookie`, `httpx`) does this by itself.
  - Using that jar, `GET /v2/checkedout/out` stays on the page (200), `accountId` is resolvable from the embedded JSON, `GET {gateway}/checkouts` and `GET {gateway}/fines` return `200`, and the same gateway call without cookies returns `401`. The whole read path works from plain HTTP with no browser.
  - `remember_me` is set to expire in 10 years (2036). The auth cookies have no expiry, so the server-side session lifetime is unknown. Handle this by re-logging-in on any `401`, not by assuming a lifetime.
  - Not tested: whether `remember_me` alone can revive an expired session (and whether `PATCH /checkouts` works from curl with just this jar; the browser needed no extra headers). My network tool only lists URL, method and status, not headers or bodies. When building the client, run a login against a throwaway wrong PIN with a cookie-jar HTTP client and log the status, `Location` header and body so the failure case can be detected reliably. Detect success by checking that the next gateway call returns 200, not by the POST status alone.

### Proposed flow

1. **Registering an account** (user enters card number/username + PIN):
   - Server does the login (below). On success, store credentials (encrypted) and the session cookies. On failure, show the error and don't store anything.
2. **Daily job, per account:**
   1. Load the stored cookie jar. Call `GET /checkouts`. If it returns `401`, the session expired, so re-login with the stored credentials, save the new cookies, and retry once.
   2. Fetch fines, normalize, and upsert into the app DB.
   3. If login fails twice (bad PIN, locked account), mark the account `needs_attention` and notify the user. Don't keep retrying, because repeated failures can lock the account.
3. **Renew (user-triggered):** use the same session, `PATCH /checkouts` with the selected `checkoutIds`, then re-fetch checkouts to refresh the cache and report per-item results.
4. **Programmatic login (HTTP):**
   1. `GET /user/login` with a cookie jar; parse `authenticity_token` from the form or meta tag.
   2. `POST` the form (urlencoded) to its action URL with the fields above, sending the same cookie jar and a normal browser `User-Agent`/`Referer`/`Origin`.
   3. Success = the POST returns `302` (a failed login returns `200` with an error message in the page JSON; see above). Then confirm with the next gateway GET returning `200`.
   4. Resolve `accountId` by `GET /v2/checkedout/out` and reading `entities.accounts[*].id` from the embedded JSON. Cache it per account.
   5. Fallback if plain HTTP login is rejected: run login once in headless Playwright and copy the cookies out. Everything after that stays plain HTTP.

### Credential handling

- Only the library card/username and PIN are needed, and they are low-privilege, but treat them as secrets: encrypt at rest (e.g. AES-GCM with a key from env/KMS), never log them, and never put them in URLs or query strings.
- Store the cookie jar per account, also encrypted.
- Prefer storing credentials over relying on cookies alone, since the cookie lifetime is unknown and the daily job must be able to re-authenticate unattended.

## Implementation notes

- Language: any HTTP client with a cookie jar (Node `undici` + `tough-cookie`, or Python `httpx`).
- Wrap the gateway in one small client module (`login`, `getCheckouts`, `getFines`, `renew`) so API drift is contained in one place.
- Validate responses with a schema (e.g. zod) and fail loudly on shape changes. This is an undocumented API and can change without notice.
- Be a polite client: one run per day, a few requests per account, random start-time jitter, a small delay between accounts, and a descriptive but ordinary `User-Agent`.
- Keep the multi-account list in the app DB. Each library account has its own cookie jar and `accountId`. Never share cookies across accounts.
- Overdue notification: derive it from the cached `dueDate < today` and `status == OUT`, and group all overdue items per user into one push.
- Terms of use: automated access to an undocumented API may be against the library's or BiblioCommons' terms. Keep traffic light and for personal use.

## Next steps / open questions

1. ~~Capture the login~~ Done: success (`302`), failure (`200` + message), auth cookie names and the cookie-jar-only read path are all verified (see Authentication).
   - Remaining: how long `session_id`/`bc_access_token` live server-side (re-test the same jar after a few hours/days), and whether `remember_me` alone revives an expired session. (`PATCH /checkouts` from curl is now verified.)
2. ~~Capture a failed renewal~~ Done: renewal limit gives HTTP 200 with a `failures` entry (see Renew). Still unseen: a mixed success+failure batch, and a hold-blocked renewal.
3. ~~Capture an itemized fine response~~ Done (see Fees). Still unseen: an overdue-accruing fine (`totalAccrued > 0`).
4. Measure how long `remember_me` sessions last in practice.
5. Decide whether to support digital (OverDrive) loans in v1.
