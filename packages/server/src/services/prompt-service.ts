import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { PromptTemplate, RenderPromptInput, RenderedPrompt, StartWorkSource } from '@lovelace/core';
import { asRecord, isNonEmptyString } from '../helpers.js';

const BUILT_IN_PROMPTS: Array<Pick<PromptTemplate, 'id' | 'title' | 'content'>> = [
  {
    id: 'implement',
    title: 'Implement',
    content: `You are helping to implement: {{title}}
{{tracker}}
{{workspaces}}

Please first summarize the task, identify the most relevant code areas, and propose a concrete implementation plan before making changes.`,
  },
  {
    id: 'review',
    title: 'Review',
    content: `You are helping to review changes related to: {{title}}
{{changeRequests}}
{{workspaces}}

Please review the selected changes using the prepared local workspaces. Summarize risk, likely impact, anything suspicious, and the recommended review outcome.`,
  },
  {
    id: 'refine',
    title: 'Refine',
    content: `You are helping to refine: {{title}}
{{tracker}}
{{workspaces}}

Please analyze the problem, extract the key requirements and open questions, and propose a refined plan or technical approach.`,
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

export function renderPrompt(lovelaceDir: string, input: RenderPromptInput): RenderedPrompt | null {
  const template = listPromptTemplates(lovelaceDir).find((entry) => entry.id === input.promptId);
  if (!template) return null;

  const variables: Record<string, string> = {
    title: input.title.trim(),
    tracker: renderTracker(input.sources ?? []),
    changeRequests: renderChangeRequests(input.sources ?? []),
    workspaces: renderWorkspaces(input.workspacePaths ?? []),
    context: input.context?.trim() ?? '',
  };
  const content = template.content.replace(/{{\s*(title|tracker|changeRequests|workspaces|context)\s*}}/g, (_, key: string) => variables[key] ?? '');
  return { promptId: template.id, content: content.replace(/\n{3,}/g, '\n\n').trim() };
}

function renderTracker(sources: StartWorkSource[]): string {
  const source = sources.find((entry) => entry.sourceType === 'tracker-item');
  if (!source) return '';
  const payload = asRecord(source.payload);
  const key = readString(payload.key) ?? source.externalId;
  const url = readString(payload.url);
  const description = readString(payload.descriptionText);
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
