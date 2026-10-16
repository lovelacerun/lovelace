# @lovelace/jira-client

Independent Jira assigned issues, project catalog and individual issue reads. Calls the generated `@lovelace/jira-platform-client` operations through a small transport using injected/native fetch with Basic auth, and `@lovelace/adf-converter` for descriptions. A plain API client: no caching, application configuration/environment/SQLite/work/session imports.

```ts
import { createJiraClient } from '@lovelace/jira-client';

const jira = createJiraClient({
  baseUrl: 'https://api.atlassian.com/ex/jira/my-cloud-id',
  siteUrl: 'https://example.atlassian.net', // browse links, defaults to baseUrl
  email: suppliedEmail,
  apiToken: suppliedToken,
  requestTimeoutMs: 15_000,
  fetch: injectedFetch, // optional; native fetch otherwise
});
if (jira.isConfigured()) {
  const issues = await jira.fetchAssignedIssues({ signal });
  const projects = await jira.fetchProjects();
  const issue = await jira.fetchIssue('EXAMPLE-42');
}
```

The credential/transport/signal variables belong to the caller.

## Guarantees and limits

- Missing auth/config rejects without calling the transport. `isConfigured()` reports configuration presence, not successful authentication.
- Each request is aborted after `requestTimeoutMs` (positive integer, default 15000, including JSON body parsing) or when the caller's optional `signal` aborts. Custom fetch implementations must honour the signal.
- HTTP errors (including rate limits), malformed/partial payloads and later-page failures reject instead of returning partial lists.
- Assigned search uses `assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`, paginating enhanced search `nextPageToken`. Projects use offset pagination. Both cap at 100 pages and reject broken/non-advancing pagination instead of silently storing partial results.
- Base URLs with a cloud API path are preserved. Issue keys are path encoded and browse links use `siteUrl`. Explicit issue 404 returns null; other errors reject.
- Exported independent `JiraIssueSummary`/`JiraProjectSummary` records include normalized status/type/author fields, Jira status category keys (null when missing upstream), and plain-text descriptions. Local work-state decisions do not belong here.
