# Cache GitHub reads

- Status: accepted
- Date: 2026-02-14

In the context of the dashboard that reads issues from GitHub, facing the secondary rate limit, we decided for a shallow query with a local cache and neglected nested queries and webhooks, to achieve reads that cost one point, accepting that changes appear up to two minutes late.
