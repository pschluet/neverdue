# Neverdue

Never pay a late fee again. Neverdue is an installable web app (PWA) that keeps track of library books across several library cards and tells you before they're due.

It targets the [Palatine Public Library District](https://palatinelibrary.bibliocommons.com), which runs on BiblioCommons.

## What it does

- **One view for every card.** Add several library logins (each with a nickname) and see everything checked out across all of them: title, which card it's on, due date, and any fees.
- **Renew from the app.** Renew a book without signing in to the library site.
- **Push notifications.** A grouped notification when books are overdue (the default), with options for how often, what time, and what triggers one (N days before due, on the due date, only if overdue, when fees appear).
- **Installable.** Add it to your home screen and use it like a native app. The UI follows Apple's Liquid Glass design.

## How it works

- A daily job signs in to each registered library account, reads the checkouts and fees, and caches them in the app's database. The app reads from that cache.
- BiblioCommons has no public API, so the job uses the same undocumented JSON gateway that the library's own website calls, over plain HTTP. No browser automation and no HTML scraping.
- The app runs on AWS serverless services (CloudFront, S3, API Gateway, Lambda, DynamoDB, Cognito) and is deployed with CDK, with a target cost well under $1/month.
- Users are invited and sign in with an emailed one-time code. Each user sees only the library accounts they added, and library PINs are stored encrypted in SSM Parameter Store and are never sent back to the browser.

## Status

Planning stage. This repo has the design and research so far and no application code yet.

| Doc | Contents |
|---|---|
| [planning/requirements.md](planning/requirements.md) | What the app should do: features, pages and notification options |
| [planning/architecture.md](planning/architecture.md) | System design: AWS components, per-user isolation, secrets, deployment and testing |
| [planning/scraping-plan.md](planning/scraping-plan.md) | How to get checkouts and fees, renew books and log in, based on traffic captured from the live site |
| [planning/scripts/](planning/scripts/) | Throwaway scripts used to verify the login and renew flows with `curl`. They prompt for credentials and don't store them |

## Planned layout

```
app/        React + Vite PWA
backend/    Lambda handlers (API and daily scraper) and shared modules
infra/      CDK app
scripts/    one-off admin helpers
```
