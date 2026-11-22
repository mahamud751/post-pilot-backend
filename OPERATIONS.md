# Business operations update

## Rollout

Apply the two new Prisma migrations before running the updated API/worker. They add inbox lead fields and persist invoice billing cycles. Existing records receive `NEW` and `monthly` defaults; existing content and invoices are retained.

```sh
npm run prisma:generate
npx prisma migrate deploy
npm run build
```

Restart the API, publishing worker and web application together after migration. Do not run integration tests against a production schema. The test configuration uses a separate `e2e` schema, or `E2E_DATABASE_URL` when supplied.

## Workspace health

- `/v1/health` is the lightweight process liveness endpoint.
- `/v1/health/ready` returns 200 only when PostgreSQL, Redis and a publishing worker are connected, and 503 otherwise. It does not disclose infrastructure details publicly.
- `/v1/dashboard/health` requires workspace membership and returns service checks plus that workspace's overdue publishing, stalled work, failures, connection warnings, pending reviews and unanswered-message counts.
- Monitor the readiness endpoint externally. The dashboard does not replace an uptime monitor. In a separate-worker deployment the worker must share the API's Redis URL and queue prefix.

Dependency probes time out after 2.5 seconds. A connected worker is a Redis worker connection, not a guarantee that each job will complete. The existing recovery sweep and duplicate-publish checks remain responsible for retries.

## Inbox and leads

Open **Inbox & leads**. Search by customer or message, filter by platform or assigned writer, and move enquiries through New, Interested, Ordered, Resolved or Lost. **Details & follow-up** exposes internal notes and recent conversation history. Lead fields belong to the selected message; they are not a global CRM contact record. Conversation history includes up to 50 messages collected by PostPilot, not every message ever sent on Meta.

Only active owners, admins and editors can modify leads. Assignment is limited to active writers in the same workspace. Viewers and approvers can read. Internal notes never go to Meta. Periodic screen refresh preserves unsent replies. Existing reply-mode, permission, compliance and message-window rules still apply.

### Optional Meta webhooks

The polling fallback continues every five minutes. To receive incoming text without waiting for polling:

1. Configure `FACEBOOK_APP_SECRET` and a random `META_WEBHOOK_VERIFY_TOKEN` on the API.
2. Register the public callback `APP_URL/webhooks/meta` in the Meta app with that verification token.
3. Subscribe the app and connected accounts to the appropriate Page feed/messages and Instagram comments/messages fields. Required app review and permissions remain necessary.
4. Enable Autopilot and the relevant comment/DM reply options for the workspace.

The receiver verifies Meta's HMAC over the raw request bytes, ignores outgoing echoes, and deduplicates account/message IDs before storing incoming text. It ignores unsupported/non-text events. Webhook delivery makes messages available to people immediately; the existing scheduler still owns AI triage and automated replies. Replayed delivery does not repeat a stored message. Polling continues if the webhook is not configured.

References: [Meta webhook authentication](https://developers.facebook.com/docs/graph-api/webhooks/getting-started#payload), [Instagram fields](https://developers.facebook.com/docs/graph-api/webhooks/reference/instagram), [Page fields](https://developers.facebook.com/docs/graph-api/webhooks/reference/page/).

## Reporting and tracked links

Analytics now includes saves, shares and video views when reported by the platform, a business report, campaign comparisons, separate currency totals, source-post-linked sales, and recommendations grounded in reported data. Reports export as Markdown; the print action supports the browser's Save as PDF option. Existing CSV export includes the additional metrics.

Metrics are lifetime values for posts published in the selected period. They are not engagement events that occurred during that period, and older posts have had longer to collect results. Summed reach is not unique people across posts. Missing metrics remain unavailable. Sales use their recorded occurrence date and attribution supplied by the store or person entering the sale. A linked sale does not prove a post caused the purchase.

The composer can add `utm_source`, `utm_medium=social` and `utm_campaign` to a destination URL for the store's analytics. UTM links do not automatically populate PostPilot sales. Instagram caption URLs are not clickable. Store integrations can continue sending authenticated requests to `/v1/conversions`, with `postId` for attribution.

## Online payments

Manual payment remains the default. To use hosted SSLCommerz checkout, configure:

```dotenv
BILLING_PROVIDER=sslcommerz
SSLCOMMERZ_STORE_ID=your-merchant-store-id
SSLCOMMERZ_STORE_PASSWORD=your-merchant-password
SSLCOMMERZ_SANDBOX=true
APP_URL=https://your-api.example/v1
WEB_APP_URL=https://your-web.example
```

Set `SSLCOMMERZ_SANDBOX=false` only with approved live credentials. The customer supplies a billing phone, address and city. Checkout redirects to the provider; card/payment credentials are never collected by PostPilot.

Callback endpoints:

- `POST /v1/billing/sslcommerz/ipn`: provider notification.
- `POST /v1/billing/sslcommerz/return`: browser return, followed by a redirect to Billing.

Activation requires a server-to-server validation response matching the persisted invoice reference, amount, currency and safe successful payment status. The invoice determines the plan and monthly/annual cycle. Duplicate notifications for the same invoice activate once. Browser status fields alone cannot activate a subscription. Unverified or cancelled returns leave the invoice pending. Timed-out checkout attempts also remain reconcilable by a later verified notification.

This is a purchase of one billing period, not a recurring debit mandate. Renewal requires another checkout. Existing signed generic webhooks and manual activation remain available. Complete sandbox merchant tests, real callback reachability and a controlled live payment before enabling live billing. No credentials are included in the code and no merchant account is provisioned by this update.

Reference: [SSLCommerz hosted checkout and payment validation](https://developer.sslcommerz.com/doc/v4/).

## Media and approvals

- The composer now selects up to ten images, with carousel previews. Facebook uploads each album image unpublished before creating one feed post. Multiple videos or image/video mixes are rejected before scheduling.
- **Crop & resize** saves a new JPEG in portrait, square or landscape format. Users can move/zoom the crop or fit the entire image against white. It preserves the original and does not change existing scheduled posts. Video playback appears in previews. This update does not add video transcoding or cover-image publishing.
- **Approvals** lists submitted posts. Review links require sign-in and active workspace membership. Invite a client as an Approver, wait for acceptance, then share a link. These are authenticated links, not publicly accessible guest links.
- Reviewers and writers can discuss a post. Review reminders are deduplicated per reviewer, version and UTC day. The existing version-specific approval and review history remain authoritative; editing invalidates approval.
- The first-week setup shortcut opens the existing campaign builder. New campaigns default to preparing drafts for review; automatic scheduling requires an explicit selection.

## Validation

```sh
npm test -- --runInBand
npm run test:e2e
npm run build
```

The new tests cover multi-image publishing failures, media mixes, signed Meta payloads, dependency timeouts, invoice validation, month-end renewal dates, lead permissions, tenant isolation, attribution and payment replay. Integration tests use fake AI/publishing providers; they do not verify real Meta publishing or merchant transactions.
