# Neverdue — Architecture

Neverdue is a small installable web app (PWA) at **neverdue.pauldev.io**. Each user signs in and adds their own library accounts (card number and PIN). Once a day the app signs in to every registered library account, records what's checked out, and sends each user a push notification about their own overdue or due-soon items. A user sees only the library accounts they added, and the checkouts on those accounts.

This document covers the shape of the system and the decisions behind it. The data model and API routes are left to the implementation: design them to fit what is described here.

## Goals and constraints

- **Low cost.** It should run for well under $1/month at small scale. That means no VPC, NAT gateway, RDS, EC2, Fargate or anything else that bills by the hour, and no Amplify.
- **Serverless and pay-per-request** throughout: Lambda, API Gateway HTTP API, DynamoDB on-demand, S3, CloudFront.
- **Infrastructure as code** with AWS CDK (TypeScript). Every resource is in the CDK stack; nothing is created by hand except the prerequisites listed below.
- **Node.js 22 on ARM64** for every Lambda, bundled with `NodejsFunction` (esbuild, minified).
- **Strict per-user isolation.** A user can never see, change, refresh or get notified about another user's library accounts or checkouts.
- **Keep it small.** A few users with a handful of library accounts each, and one scheduled run a day. Don't add queues, Step Functions or caching layers unless a real need appears.

## High-level design

```
             neverdue.pauldev.io (Route 53 alias, ACM cert in us-east-1)
                                 │
                            CloudFront
                 ┌───────────────┴────────────────┐
           default "/*"                       "/api/*"
                 │                                │
     S3 site bucket (private, OAC)     API Gateway HTTP API (Cognito JWT authorizer)
     React + Vite PWA                             │
     (manifest + service worker)              API Lambda ──────────────┐
                                                  │    │               │ async invoke
                                                  │    └─► SSM (write/delete only)
                                                  │                    ▼
                                              DynamoDB  ◄──── Scraper Lambda ◄── EventBridge Scheduler (daily)
                                                                   │   │
                                         SSM Parameter Store (read)    └──► Web Push services (Apple / Google / Mozilla)
                                         SecureString library credentials    via VAPID
```

The app and the API share one origin through CloudFront, so there's no CORS to configure.

## Identity and isolation

- **The owner is the Cognito `sub`.** Every library account, loan, push subscription and notification-state record belongs to one user, identified by the `sub` claim from the verified JWT.
- **The API always takes the user ID from the authorizer's JWT claims, never from the request.** Don't accept a client-supplied user ID or owner field anywhere.
- **Start every key with the owner's `sub`** (for example `pk = USER#<sub>`). Every query then only ever reaches the caller's own records, and a single-item read, update or delete can't touch someone else's data even if the client sends another account's ID.
- **Look up a library account by owner and account ID together.** The API returns 404, not 403, when the account doesn't belong to the caller, so it doesn't reveal that the account exists.
- **Push notifications go only to the owner's own devices** and only mention that owner's loans.
- **Tests cover isolation:** user A can't list, read, refresh, edit or delete user B's accounts or loans.

## Components

### Front end: `app/`
- **React + Vite + TypeScript** single-page app, served as a PWA:
  - It has a web app manifest with icons, `display: standalone`, the theme color, and `name`/`short_name` set to "Neverdue".
  - Its service worker caches the app shell so it opens instantly from the home screen. It also handles `push` events (shows the notification) and `notificationclick` events (focuses or opens the app). A hand-written service worker is fine; don't add Workbox unless it clearly earns its place.
  - API responses are **not** cached by the service worker, so the list on screen is always current.
  - Sign-out clears every cached user data from memory. Nothing from another user may show up on a shared device.
- **Sign-in:** Cognito's email one-time code through the AWS Amplify Auth **JS library only** (`aws-amplify/auth`, `signIn` with `USER_AUTH` / `EMAIL_OTP`), or the Cognito SDK directly. No Amplify CLI, backend or hosting.
- **Library accounts screen:** add, rename and remove the user's own library accounts.
  - Adding one asks for a display name (such as "Kids' card"), the card number and the PIN.
  - Updating the PIN is supported.
  - The card number and PIN are **never** shown again or returned by the API. Show only the display name, a masked card number (last 4 digits), when the account was last refreshed, and any error from the last refresh.
- **Main view:** what's checked out across the user's own library accounts. Show title, which account it's on, and due date. Sort by due date, with overdue items at the top and visibly highlighted. Also show when the data was last refreshed.
- **Notifications toggle:** asks for notification permission, subscribes with the VAPID public key and sends the subscription to the API, where it's stored under the signed-in user. Turning it off removes the subscription. On iOS, push only works once the app has been added to the Home Screen, so detect that case and show a short "Add to Home Screen first" hint.
- **Manual refresh:** a button that triggers an on-demand scrape of the **caller's own** accounts.

### API: `backend/src/api.ts`
- One Lambda behind the HTTP API route `/api/{proxy+}`, with the route defaulting to the Cognito JWT authorizer. The handler routes requests internally.
- It handles:
  - listing loans;
  - library account create, update and delete;
  - storing and deleting push subscriptions;
  - starting a manual refresh.
- **Adding or updating a library account:**
  1. Validate the credentials with a test sign-in through the shared library client. Reject them if the sign-in fails.
  2. Write the credentials to SSM (see *Secrets*).
  3. Store the account metadata (but not the credentials) in DynamoDB.
  4. Kick off a refresh of that account.
- **Deleting a library account** deletes its SSM parameter, its metadata and its loans.
- **Manual refresh** invokes the scraper Lambda **asynchronously** (`InvocationType: Event`) with the caller's `sub`, so the scraper only processes that user's accounts. Rate-limit it per user (for example once every 5 minutes) so nobody can hammer the library site.
- **Renew:** `POST /api/accounts/{id}/renew` checks the checkout IDs belong to that account, signs in with the stored credentials, renews, re-fetches the snapshot and returns per-item results. A failed renewal is still an HTTP 200 from the library, so the client reads `failures`.
- **Preferences:** `GET`/`PUT /api/prefs` store the user's notification triggers, frequency, hour and time zone.
- The API Lambda can **read, write and delete** credential parameters under `/neverdue/users/*`, because it signs in to validate and renew. (Revised from the earlier write-only design.)
- Memory 256 MB, timeout 29 s. Allow enough time for sign-in plus renew.

### Scraper: `backend/src/scrape.ts`
- **Daily run:** triggered by **EventBridge Scheduler** with a cron in the `America/Chicago` time zone (for example 7:00 AM; make it configurable). It processes every registered library account, for all users.
- **On-demand run:** the API Lambda invokes it with a user `sub`, or a single account ID. It processes only that scope.
- For each library account:
  1. Read the credentials from SSM Parameter Store.
  2. Sign in with a plain `fetch` form POST, keeping the session cookie between requests in a small cookie jar.
  3. Call the library's JSON API for current checkouts.
  4. Normalize the results and write them to DynamoDB under the account's owner, replacing that account's previous snapshot so returned books disappear.
- **Concurrency:** process accounts with bounded concurrency (for example 3 at a time). Process them **independently**: a failure on one account is recorded on that account (shown in the UI as "couldn't refresh *name*") and doesn't stop the others.
- Notifications are sent by a separate **notifier Lambda** (`backend/src/notify.ts`), not the scraper.
- No headless browser and no container image: a normal `NodejsFunction`. Memory 256 MB, timeout 5 minutes, which leaves plenty of room as accounts are added.
- Never log credentials, session cookies or full response bodies.

### Notifier: `backend/src/notify.ts`
- Runs **hourly** from a second EventBridge Scheduler entry (`America/Chicago`). It reads only cached data.
- For each user with saved preferences, it checks whether the current hour in the user's own time zone matches their chosen hour (and weekday, for weekly). At most one send per slot, tracked in the user's state item.
- It matches the user's loans and fees against their triggers (overdue, due today, within N days, fees) and sends **one grouped notification to each of that user's devices**. Nothing is sent when nothing matches.
- Send with the `web-push` npm package using VAPID keys. When a push service answers **404 or 410**, delete that subscription.

### Data: DynamoDB
- **One on-demand table**, using a single-table design (`pk`/`sk`), with `RemovalPolicy.RETAIN`.
- It holds each user's:
  - library account metadata (display name, masked card number, last successful refresh, last error);
  - current loans for each account;
  - push subscriptions;
  - notification state for avoiding repeats.
- **The daily run needs to list every library account across users.** Use a GSI or a sparse index for that, rather than a table scan, if it stays simple; at this scale a scan is acceptable too.
- The exact item shapes are up to the implementation, within the isolation rules above.

### Secrets
- **Library credentials:** SSM Parameter Store **SecureString** parameters, encrypted with the AWS-managed `aws/ssm` key. Standard parameters are free, up to 10,000 per account and region.
  - Each parameter holds a small JSON object with the card number and PIN, at the path `/neverdue/users/<sub>/accounts/<accountId>`.
  - The API Lambda creates and deletes them when users add or remove library accounts. Build the path from the JWT `sub` on the server, never from client input. Validate `accountId` as a server-generated ID (for example a ULID).
  - **IAM:**
    - API Lambda: `ssm:GetParameter`, `ssm:PutParameter`, `ssm:DeleteParameter` and `ssm:AddTagsToResource` on `/neverdue/users/*`.
    - Scraper Lambda: `ssm:GetParameter` on `/neverdue/users/*` only.
    - Notifier Lambda: `ssm:GetParameter` on the VAPID key only.
    - Nothing else gets access.
  - Credentials are never stored in DynamoDB, returned by the API, or sent back to the browser.
- **VAPID keys:** generate them once with `npx web-push generate-vapid-keys`. Store the private key as a SecureString in SSM at `/neverdue/vapid-private-key`, readable only by the notifier. The public key is not secret: pass it to the front-end build as a Vite env var, and to the scraper as a Lambda environment variable.

### Auth: Cognito
- A user pool with **invite-only** app users (`selfSignUpEnabled: false`) and email as the sign-in alias. Once signed in, each user manages their own library accounts.
- Passwordless email one-time code: `featurePlan: ESSENTIALS`, `signInPolicy.allowedFirstAuthFactors` `{ password: true, emailOtp: true }`. Password has to stay allowed at the policy level, but users never get one.
- An app client with `authFlows: { user: true }`, no secret and OAuth disabled. Access and ID tokens last 1 hour; refresh tokens last 30 days, so phones stay signed in.
- Email goes through **SES** from `no-reply@pauldev.io`, using the domain identity already verified in us-east-1.
- App users are created with `AdminCreateUser`, either from the console or a small script in `scripts/`. No admin UI.
- **Deleting an app user** should also remove all of their data: their DynamoDB items and their SSM parameters. Provide a script for it in `scripts/`.

### Edge, domain and TLS
- A CloudFront distribution:
  - The default behavior serves the private site bucket through Origin Access Control, with `CACHING_OPTIMIZED`.
  - `/api/*` goes to the HTTP API, with caching disabled, the `ALL_VIEWER_EXCEPT_HOST_HEADER` origin request policy and all methods allowed.
  - Serve `index.html`, `sw.js` and `manifest.webmanifest` with `Cache-Control: no-cache`, set during deploy, so app updates reach phones. Hashed assets under `/assets/*` can be cached long-term.
  - Do **not** add distribution-wide 403/404 → `index.html` error responses. They would also replace real JSON errors from `/api/*`. If client-side routing is added, use a CloudFront Function on the default behavior instead.
- Route 53 A and AAAA alias records for **neverdue.pauldev.io** to CloudFront, in the existing `pauldev.io` hosted zone.
- An existing ACM certificate in **us-east-1** covering `neverdue.pauldev.io`, imported by ARN.

## Repo layout

```
app/        React + Vite PWA
backend/    Lambda handlers (api.ts, scrape.ts) + shared modules (library client, push, db, credentials)
infra/      CDK app (bin/app.ts, lib/neverdue-stack.ts, test/)
scripts/    one-off helpers (create user, delete user and their data, put VAPID key)
.github/workflows/  ci.yml, deploy.yml
```

Keep the **library client** (sign-in plus fetching checkouts) in its own module, behind a small interface. The API (to validate credentials) and the scraper both use it. It can be unit tested against recorded fixtures and swapped out if the library changes vendors.

## Deployment and CI

- **One CDK stack** (`NeverdueStack`) in `us-east-1`. Stack configuration (domain name, hosted zone ID and name, certificate ARN, GitHub repo, schedule) lives in `infra/bin/app.ts` or `cdk.json` context. No secrets go there.
- **GitHub Actions deploys through OIDC.** The `token.actions.githubusercontent.com` OIDC provider **already exists in the AWS account**, so import it with `OpenIdConnectProvider.fromOpenIdConnectProviderArn` instead of creating it. The deploy role:
  - trusts only this repo, matching both `repo:owner/repo:*` and `repo:owner@*/repo@*:*` in the `sub` claim;
  - can only `sts:AssumeRole` into the `cdk-hnb659fds-*` bootstrap roles and `cloudformation:DescribeStacks` on `CDKToolkit`;
  - also gets read/write access to the site bucket (for `aws s3 sync`) and `cloudfront:CreateInvalidation` on this distribution.
  - It does **not** get AdministratorAccess.
- **`ci.yml`** runs on PRs and non-`main` pushes: format check, lint, type-check, unit tests, the Vite build and `cdk synth`.
- **`deploy.yml`** runs on push to `main`: `cdk deploy`, then build the app, `aws s3 sync --delete` to the site bucket (with no-cache headers on the shell files), then invalidate CloudFront.
- **Stack outputs:** site URL, user pool and client IDs, site bucket name, distribution ID and deploy role ARN.

## Testing

- **Vitest** across `app/`, `backend/` and `infra/`.
- **Backend:**
  - Unit-test the library client against recorded, anonymized JSON fixtures.
  - Test the notify/don't-notify logic for each user (due-soon window, avoiding repeats, removing subscriptions on 404/410).
  - Test **per-user isolation** on every API operation.
  - Test that credentials never appear in API responses or logs.
- **Infra:** use CDK `Template` assertions for the important parts:
  - the JWT authorizer on the API;
  - the API Lambda has SSM read/write/delete and the scraper has `GetParameter` only, both limited to `/neverdue/users/*`; the notifier can read only the VAPID key;
  - the schedule's time zone;
  - no NAT or VPC resources.

## Deploy role bootstrap

The GitHub deploy role is created by this stack, so the **first deploy must be run locally** (`npm run deploy -w infra` with AWS credentials). After that, set the repository variable `AWS_DEPLOY_ROLE_ARN` to the `DeployRoleArn` output and pushes to `main` deploy through OIDC.

## One-time manual setup (outside CDK)

1. Bootstrap CDK in the account and region, if it isn't already.
2. Make sure an ACM certificate covering `neverdue.pauldev.io` is issued in us-east-1.
3. Make sure SES has `pauldev.io` verified, out of the sandbox if users' addresses aren't individually verified.
4. Run `npx tsx scripts/put-vapid-key.ts`: it stores the private key in SSM and prints the public key to put in `infra/cdk.json` (`vapidPublicKey`).
5. After the first deploy, create Cognito users. Each user then adds their own library accounts in the app.
