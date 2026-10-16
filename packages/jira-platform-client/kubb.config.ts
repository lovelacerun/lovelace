import { defineConfig } from '@kubb/core';
import { pluginClient } from '@kubb/plugin-client';
import { pluginOas } from '@kubb/plugin-oas';
import { pluginTs } from '@kubb/plugin-ts';

// Only the operations @lovelace/jira-client calls.
const include = [/^searchAndReconsileIssuesUsingJqlPost$/, /^getIssue$/, /^searchProjects$/].map((pattern) => ({
  type: 'operationId' as const,
  pattern,
}));

export default defineConfig({
  input: {
    path: './openapi.json',
  },
  output: {
    path: 'src/gen',
    clean: true,
    format: false,
    lint: false,
  },
  plugins: [
    pluginOas({
      generators: [],
    }),
    pluginTs({
      output: {
        path: 'types',
      },
      include,
    }),
    pluginClient({
      output: {
        path: 'client',
      },
      include,
      client: 'fetch',
      bundle: true,
      paramsType: 'object',
      dataReturnType: 'full',
    }),
  ],
});
