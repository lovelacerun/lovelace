import { defineConfig } from 'kubb';
import { pluginClient } from '@kubb/plugin-client';
import { pluginOas } from '@kubb/plugin-oas';
import { pluginTs } from '@kubb/plugin-ts';

const include = [
  /^\/rest\/agile\/1\.0\/board$/,
  /^\/rest\/agile\/1\.0\/board\/\{boardId\}\/configuration$/,
  /^\/rest\/agile\/1\.0\/board\/\{boardId\}\/sprint$/,
  /^\/rest\/agile\/1\.0\/sprint\/\{sprintId\}\/issue$/,
].map((pattern) => ({
  type: 'path' as const,
  pattern,
}));

export default defineConfig({
  input: {
    path: './openapi.json',
  },
  output: {
    path: 'src/gen',
  },
  plugins: [
    pluginOas({
      output: {
        path: '.kubb/oas',
      },
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
    }),
  ],
});
