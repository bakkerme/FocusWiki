import { describe, expect, it } from 'vitest';
import {
  createHeadingSlugger,
  markdownToProseMirror,
  proseMirrorToMarkdown,
  resolveMarkdownLink,
  resolveRepoRelativePath
} from '../shared/markdownCodec';
import type { ProseMirrorNode } from '../shared/types';

function images(node: ProseMirrorNode): ProseMirrorNode[] {
  return node.type === 'image' ? [node] : (node.content ?? []).flatMap(images);
}

describe('Markdown images', () => {
  it.each([
    ['![alt](./img/test.png)\n', './img/test.png', null],
    ['![alt](https://example.com/a.png "Diagram")\n', 'https://example.com/a.png', 'Diagram']
  ])('round-trips %s as an editable image', (markdown, src, title) => {
    const doc = markdownToProseMirror(markdown);
    expect(images(doc)).toEqual([{ type: 'image', attrs: { src, alt: 'alt', title } }]);
    expect(proseMirrorToMarkdown(doc)).toBe(markdown);
    expect(proseMirrorToMarkdown(doc, markdown)).toBe(markdown);
  });

  it('retains inline images, linked images, tables, and untouched formatting while editing prose', () => {
    const table = '| Label | Illustration |\n| --- | --- |\n| Demo | ![Cell](assets/cell.svg "Cell title") |';
    const markdown = `# Fictional station\n\nBefore ![Inline](./img/a.png "Inline title") after.\n\n[![Linked](assets/b.svg)](./overview.md#details)\n\n${table}\n`;
    const doc = markdownToProseMirror(markdown);
    expect(images(doc)).toHaveLength(3);
    expect(proseMirrorToMarkdown(doc, markdown)).toBe(markdown);
    const paragraph = doc.content![1];
    paragraph.content![0].text = 'Changed ';
    const edited = proseMirrorToMarkdown(doc, markdown);
    expect(edited).toContain('Changed ![Inline](./img/a.png "Inline title") after.');
    expect(edited).toContain('[![Linked](assets/b.svg)](./overview.md#details)');
    expect(edited).toContain(table);
    expect(images(markdownToProseMirror(edited))).toEqual(images(doc));
    const canonical = proseMirrorToMarkdown(doc);
    expect(proseMirrorToMarkdown(markdownToProseMirror(canonical))).toBe(canonical);
  });

  it('serializes newly inserted inline and block image nodes with original paths and metadata', () => {
    const doc: ProseMirrorNode = { type: 'doc', content: [
      { type: 'image', attrs: { src: '../assets/block.svg', alt: 'Block', title: 'Overview' } },
      { type: 'paragraph', content: [{ type: 'text', text: 'See ' }, { type: 'image', attrs: { src: './inline.png', alt: 'Inline', title: null } }] }
    ] };
    const markdown = proseMirrorToMarkdown(doc);
    expect(markdown).toBe('![Block](../assets/block.svg "Overview")\n\nSee ![Inline](./inline.png)\n');
    expect(images(markdownToProseMirror(markdown))).toHaveLength(2);
  });

  it('preserves escaped alt text and titles with punctuation across repeated edits', () => {
    const markdown = '![A \\[sample\\]](./images/plot.png "Diagram: phase 2")\n';
    const first = markdownToProseMirror(markdown);
    expect(images(markdownToProseMirror(proseMirrorToMarkdown(first)))).toEqual(images(first));
  });
});

describe('repository document and asset paths', () => {
  it.each([
    ['README.md', './intro.md', 'intro.md', null],
    ['README.md', 'arch.md#auth', 'arch.md', 'auth'],
    ['docs/sub/page.md', './intro.md', 'docs/sub/intro.md', null],
    ['docs/sub/page.md', '../overview.md', 'docs/overview.md', null],
    ['docs/sub/page.md', '../../README.md#start', 'README.md', 'start'],
    ['docs/sub/page.md', 'arch.md#auth', 'docs/sub/arch.md', 'auth'],
    ['docs/sub/page.md', '#heading', 'docs/sub/page.md', 'heading'],
    ['docs/sub/page.md', '/README.md#start', 'README.md', 'start'],
    ['docs/sub/page.md', '../a%20b.md#caf%C3%A9', 'docs/a b.md', 'café']
  ])('resolves %s + %s', (docPath, href, path, fragment) => {
    expect(resolveMarkdownLink(docPath, href)).toEqual({ path, fragment });
  });

  it.each(['../escape.md', '%2e%2e/escape.md', '//outside/doc.md', 'https://example.com/a.md', 'javascript:alert.md', '.git/config.md', '%ZZ.md', '..\\escape.md'])('blocks unsafe root link %s', (href) => {
    expect(resolveMarkdownLink('README.md', href)).toBeNull();
  });

  it('blocks traversal above the root from nested documents and validates asset paths', () => {
    expect(resolveMarkdownLink('docs/sub/page.md', '../../../escape.md')).toBeNull();
    expect(resolveMarkdownLink('docs/sub/page.md', '../%2e%2e/../escape.md')).toBeNull();
    expect(resolveMarkdownLink('README.md', 'diagram.png')).toBeNull();
    expect(resolveRepoRelativePath('docs/sub/page.md', '../images/flow.svg')).toBe('docs/images/flow.svg');
    expect(resolveRepoRelativePath('README.md', '../private.png')).toBeNull();
  });
});

describe('GitHub-style heading anchors', () => {
  it('is deterministic and handles duplicates and suffix collisions per document', () => {
    const headings = ['Hello, World!', 'Hello, World!', 'hello-world-1', 'Hello, World!', 'Café & résumé', 'Code_value'];
    const slug = createHeadingSlugger();
    const expected = ['hello-world', 'hello-world-1', 'hello-world-1-1', 'hello-world-2', 'café--résumé', 'code_value'];
    expect(headings.map(slug)).toEqual(expected);
    expect(headings.map(createHeadingSlugger())).toEqual(expected);
  });
});
