export interface JiraIssueSummary {
  id: string;
  key: string;
  title: string;
  url: string;
  project: string | null;
  status: string | null;
  /** Jira status category key. */
  statusCategory: string | null;
  issueType: string | null;
  type: string | null;
  author: string | null;
  descriptionText: string | null;
  updatedAt: string;
}

export interface JiraProjectSummary {
  id: string;
  key: string;
  name: string;
  url: string;
}
