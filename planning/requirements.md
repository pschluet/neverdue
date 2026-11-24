# Overview
I'm making an app that enables users to register multiple logins with bibliocommons.com (https://palatinelibrary.bibliocommons.com/user/login). It will then allow the user to see the following across all logins:
- What books are checked out
- When they are due
- What fees are due (if any)
It will also allow the user to renew checkouts on books.

# Notifications
- The app will be a PWA that allows the user to install it on their homescreen, and it will send users push notifications based on their preferences.
- Default is to get a notification when a book is overdue (and if there are multiple overdue, send out one notification with all of them)

# Scraping
- When scraping https://palatinelibrary.bibliocommons.com, the preferred route is to use public APIs, if available. If not, use undocumented APIs. Least preferable is to actually scrape rendered html.
- The scraping job that checks due dates on all of the accounts runs once per day and caches data in the app database.

# Design
- Use the Apple Liquid Glass design system (https://developer.apple.com/documentation/technologyoverviews/liquid-glass) for the UI

# Pages
## Configuration
- Allow users to enter logins (username and password/pins as well as a nickname for each)

## Checkouts
- See all current checkouts across all accounts
- Sort by due date (default; soonest due date first)
- Filter by account
- Allow user to renew each book

## Notifications
- Setup notifications (default is to get a grouped notification for all books that are overdue once per day)
- Enable user to setup how often (once per day, once per week, etc.) and what time the notifications come out as well as what the notifications are for (n day(s) before due date; on due date; only if overdue; get notified when there are fees)