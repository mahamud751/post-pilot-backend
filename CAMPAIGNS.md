# Daily AI campaigns

Open **AI campaigns** in the website sidebar. The client chooses 7 or 30 days, a starting date and daily posting time, connected accounts, a language, and creative direction. Add actual menu items, prices, approved offers, and brand voice to the brand kit first.

Each day becomes one editable post with a separate caption for every selected platform. Uploaded photos and videos rotate in selection order, one file per day. Alternatively, an image model generates a visual per day. AI video mode creates a short clip from an image; it does not generate filmed restaurant footage. Use uploaded videos for that workflow.

Owners and workspace admins can authorize automatic scheduling. Editors can prepare campaigns for review. Workspace approval rules still apply. Flagged copy stays in draft unless a person reviews and approves that version. Post edits withdraw existing schedules and require scheduling the revised version again. The composer exposes channel captions and a button to apply the main text to every channel.

Prepared posts appear in the existing calendar and queue. Clients and workspace admins can review, edit, replace media, and delete them. Deleted days remain skipped when the campaign is retried. Unfinished days can be moved or removed after pausing preparation. Changing a time does not automatically resume generation.

**Pause** stops preparation; already scheduled posts keep their times. **Cancel** stops preparation and withdraws scheduled publishing jobs. Work already being published may finish, and content already published stays on the platform.

## Run locally or deploy

Run these from the backend directory:

```sh
npm run prisma:generate
npx prisma migrate deploy
npm run build
```

The API process runs campaign preparation by default, alongside the existing publishing worker. For separate services, use `PUBLISH_WORKER=off` in the API and run `npm run start:worker` in a continuously running worker process. `CAMPAIGN_WORKER=off` disables campaign preparation in that process. The worker must use the same database, Redis, encryption key, provider settings, and media storage as the API. Use the existing deployment's shared upload directory when running multiple processes or hosts.

Required services: PostgreSQL and Redis. Configure `GEMINI_API_KEY` or `OPENAI_API_KEY` and a valid text model. AI media uses the existing image provider and optional `GEMINI_IMAGE_MODEL` / `OPENAI_IMAGE_MODEL`. Install FFmpeg for image clips and for converting AI images into Instagram-compatible 1080×1350 JPEGs. Uploaded media does not require FFmpeg. Public signed media URLs must be accessible to Meta when a post publishes.

Campaigns have persisted daily checkpoints, a renewable database lease, and a unique creation request key. They survive closed browsers and worker restarts. Failed days require an explicit retry; completed posts, edits, and attached media are retained. An interrupted provider request can have consumed credits before its checkpoint is persisted, so repeated attempts can increase the final cost.

Facebook Pages and Instagram Professional accounts are currently supported. Unsupported networks are not offered as publishing destinations. Tokens must be valid through the end of the campaign; reconnect accounts when necessary.

## Credits and publishing allowances

| Campaign | Caption credits | AI media credits | Estimated total |
| --- | ---: | ---: | ---: |
| 7 days, own media or text | 7 | 0 | 7 |
| 7 days, AI image or clip | 7 | 28 | 35 |
| 30 days, own media or text | 30 | 0 | 30 |
| 30 days, AI image or clip | 30 | 120 | 150 |

One daily caption request adapts the copy for all selected platforms. Publishing allowances count destinations: 30 daily posts to two accounts use 60 publishing destinations. The builder shows estimates and remaining allowances; server checks run before campaign creation and during preparation and scheduling. No account is billed automatically by this feature.

## API and verification

Workspace-authenticated endpoints:

- `GET /v1/campaigns/options`: provider readiness and credit/allowance information.
- `GET /v1/campaigns`, `POST /v1/campaigns`: list or create a campaign.
- `GET /v1/campaigns/:id`: persisted daily progress and current posts.
- `POST /v1/campaigns/:id/actions`: pause, resume, retry, schedule, or cancel.
- `PATCH /v1/campaigns/:id/items/:itemId`: move or remove an unfinished day.

Campaign posts use the existing `/v1/posts` editing, review, deletion, and scheduling endpoints. Access is scoped to the selected workspace and its member roles.

`test/campaigns.e2e-spec.ts` covers weekly and monthly coverage, concurrent workers, request deduplication, approval gates, preserved edits, permanent deletion, cancellation, quota and tenant validation, crash recovery, flagged facts, image failures, and pausing during a generation. It uses fake AI and publishing providers. Use a separate `E2E_DATABASE_URL` schema when running integration tests.
