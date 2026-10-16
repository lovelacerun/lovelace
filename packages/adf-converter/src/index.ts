export interface AdfNode {
  type: string;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
}

export function adfToText(node: AdfNode | null | undefined, depth = 0): string {
  if (!node) return '';

  switch (node.type) {
    case 'doc':
      return (node.content ?? []).map((c) => adfToText(c, depth)).join('\n');
    case 'paragraph':
      return (
        (node.content ?? []).map((c) => adfToText(c, depth)).join('') + '\n'
      );
    case 'text':
      return node.text ?? '';
    case 'heading': {
      const level = (node.attrs?.level as number) ?? 1;
      const prefix = '#'.repeat(level) + ' ';
      return (
        prefix +
        (node.content ?? []).map((c) => adfToText(c, depth)).join('') +
        '\n'
      );
    }
    case 'bulletList':
    case 'orderedList':
      return (node.content ?? []).map((c) => adfToText(c, depth)).join('');
    case 'listItem': {
      const indent = '  '.repeat(depth);
      const text = (node.content ?? [])
        .map((c) => adfToText(c, depth + 1))
        .join('')
        .trim();
      return indent + '- ' + text + '\n';
    }
    case 'codeBlock': {
      const lang = (node.attrs?.language as string) ?? '';
      const code = (node.content ?? [])
        .map((c) => adfToText(c, depth))
        .join('');
      return '```' + lang + '\n' + code + '```\n';
    }
    case 'hardBreak':
      return '\n';
    case 'inlineCard':
      return (node.attrs?.url as string) ?? '';
    case 'mention':
      return '@' + ((node.attrs?.text as string) ?? '');
    default:
      return (node.content ?? []).map((c) => adfToText(c, depth)).join('');
  }
}
