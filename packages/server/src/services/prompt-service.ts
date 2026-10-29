import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { PromptTemplate, RenderPromptInput, RenderedPrompt, StartWorkSource } from '@lovelace/core';
import { asRecord, isNonEmptyString } from '../helpers.js';

const BUILT_IN_PROMPTS: Array<Pick<PromptTemplate, 'id' | 'title' | 'content'>> = [
  // Empty, so a prompt starts blank unless `prompts/default.md` overrides it.
  { id: 'default', title: 'Default', content: '' },
  {
    id: 'implement',
    title: 'Implement',
    content: `Implement: {{title}}
{{tracker}}
{{workspaces}}

Summarize the task and identify the relevant code first. If the task is ambiguous or touches more than a few areas, propose a plan and wait for my confirmation; otherwise implement it, run the relevant checks and summarize what changed.`,
  },
  {
    id: 'review',
    title: 'Review',
    content: `Review the changes for: {{title}}
{{changeRequests}}
{{workspaces}}

Review the selected changes in the prepared local workspaces. Report risks, likely impact, anything suspicious and your recommended outcome to me. Do not push commits, comment on the pull requests or change their state.

Find the tracker issues these changes belong to, for example issue keys in the pull request title, branch or description, and attach any that are not attached yet to this Lovelace work item (\`work attach-jira\`). Attaching only changes local Lovelace state.`,
  },
  {
    id: 'refine',
    title: 'Refine',
    content: `Refine: {{title}}
{{tracker}}
{{workspaces}}

Analyze the problem, extract the key requirements and open questions, and propose a refined plan or technical approach. Do not change code.`,
  },
];

export function listPromptTemplates(lovelaceDir: string): PromptTemplate[] {
  const promptDir = join(lovelaceDir, 'prompts');
  const files = existsSync(promptDir)
    ? readdirSync(promptDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'agent-context.md')
        .map((entry) => entry.name)
        .sort()
    : [];
  const userPrompts = new Map(
    files.map((file) => {
      const id = basename(file, '.md');
      return [id, { id, title: titleFromId(id), content: readFileSync(join(promptDir, file), 'utf8') }] as const;
    }),
  );

  const templates: PromptTemplate[] = BUILT_IN_PROMPTS.map((builtIn) => {
    const override = userPrompts.get(builtIn.id);
    userPrompts.delete(builtIn.id);
    return {
      ...builtIn,
      content: override?.content ?? builtIn.content,
      builtIn: true,
      overridden: Boolean(override),
    } satisfies PromptTemplate;
  });

  templates.push(
    ...[...userPrompts.values()].map((prompt) => ({
      ...prompt,
      builtIn: false,
      overridden: false,
    })),
  );
  return templates;
}

/** Fills a template's placeholders; the agent context is appended at launch, not here. */
export function renderPrompt(lovelaceDir: string, input: RenderPromptInput): RenderedPrompt | null {
  const template = listPromptTemplates(lovelaceDir).find((entry) => entry.id === input.promptId);
  if (!template) return null;

  const variables: Record<string, string> = {
    title: input.title.trim(),
    tracker: renderTracker(input.sources ?? []),
    changeRequests: renderChangeRequests(input.sources ?? []),
    workspaces: renderWorkspaces(input.workspacePaths ?? []),
  };
  const content = template.content.replace(/{{\s*(title|tracker|changeRequests|workspaces)\s*}}/g, (_, key: string) => variables[key] ?? '');
  return { promptId: template.id, content: content.replace(/\n{3,}/g, '\n\n').trim() };
}

function renderTracker(sources: StartWorkSource[]): string {
  const source = sources.find((entry) => entry.sourceType === 'tracker-item');
  if (!source) return '';
  const payload = asRecord(source.payload);
  const key = readString(payload.key) ?? source.externalId;
  const url = readString(payload.url);
  const description = readString(payload.description);
  const lines = ['Tracker item:', `- ${key}`];
  if (url) lines.push(`- ${url}`);
  if (description) lines.push('', 'Full tracker description:', '---', description, '---');
  return lines.join('\n');
}

function renderChangeRequests(sources: StartWorkSource[]): string {
  const urls = sources
    .filter((entry) => entry.sourceType === 'change-request')
    .map((entry) => readString(asRecord(entry.payload).url))
    .filter((value): value is string => Boolean(value));
  return urls.length > 0 ? ['Selected change requests:', ...urls.map((url) => `- ${url}`)].join('\n') : '';
}

function renderWorkspaces(paths: string[]): string {
  const uniquePaths = [...new Set(paths.map((path) => path.trim()).filter(Boolean))];
  return uniquePaths.length > 0 ? ['Local repository/workspace paths:', ...uniquePaths.map((path) => `- ${path}`)].join('\n') : '';
}

function readString(value: unknown): string | null {
  return isNonEmptyString(value) ? value.trim() : null;
}

function titleFromId(id: string): string {
  return id
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
