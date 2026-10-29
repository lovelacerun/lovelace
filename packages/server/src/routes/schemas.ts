import { isCodingHarnessId, isToolLaunchOptionsById, type CodingHarnessId, type ToolLaunchOptionsById } from '@lovelace/core';
import { z } from 'zod';
import { UUID } from '../helpers.js';

export const nonEmpty = z.string().refine(value => value.trim().length > 0, 'must not be empty');
const optionalNonEmpty = nonEmpty.nullish();

export const sourceType = z.enum(['tracker-item', 'change-request']);
export const startWorkSource = z.object({ sourceType, provider: nonEmpty, externalId: nonEmpty, payload: z.unknown().optional() });

export const startWorkRepository = z.object({
  repoId: nonEmpty,
  role: z.enum(['primary', 'secondary']).optional(),
  workspaceMode: z.enum(['fresh', 'change-request']).optional(),
  sourceExternalId: optionalNonEmpty,
  branchName: optionalNonEmpty,
  /** Branch a fresh worktree starts from; defaults to the repository's default branch. */
  baseBranch: optionalNonEmpty,
});

export const uuid = z.string().regex(UUID, 'must be a UUID').transform(value => value.toLowerCase());

const launchFields = {
  /** The exact edited prompt, whitespace included. */
  prompt: z.string().refine(value => value.trim().length > 0 && !value.includes('\0'), 'prompt is required and must not contain NUL'),
  /** Request identity; the same ID never launches twice. */
  requestId: uuid.optional(),
  /** false returns durable acceptance without waiting for preparation and agent startup. */
  wait: z.boolean().optional(),
  agentId: z.custom<CodingHarnessId>(isCodingHarnessId, 'agentId must be pi, claude, or codex').optional(),
  options: z.custom<ToolLaunchOptionsById>(isToolLaunchOptionsById, 'invalid harness options').optional(),
  /** Explicit catalog IDs to prepare; empty or omitted prepares none. */
  repoIds: z.array(z.string().refine(id => id.trim().length > 0 && !id.includes('\0'))).max(100)
    .refine(ids => new Set(ids).size === ids.length, 'repoIds must contain unique repository IDs (at most 100)').optional(),
  /** Template provenance only; the prompt is the exact edited final text. */
  promptId: nonEmpty.optional(),
};

const trimmedId = z.string().trim().min(1).nullish();

export const quickStartInput = z.object({
  ...launchFields,
  trackerIssueId: trimmedId,
  /** Review request to attach; its repository must be among `repoIds` and is checked out at the pull request's branch. */
  reviewRequestId: trimmedId,
});

export const newSessionInput = z.object({ workItemId: z.string(), ...launchFields });
