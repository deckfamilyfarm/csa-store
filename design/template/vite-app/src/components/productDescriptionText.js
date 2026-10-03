// Plain-text editing: blank lines separate paragraphs; - or • begins a list item.
export function descriptionBlocks(value) {
  const blocks = [];
  for (const line of String(value || '').split(/\r?\n/)) {
    const bullet = line.match(/^\s*[-*•]\s+(.+)$/);
    const type = bullet ? 'list' : line.trim() ? 'paragraph' : null;
    if (!type) { if (blocks.length) blocks[blocks.length - 1].closed = true; continue; }
    let block = blocks[blocks.length - 1];
    if (!block || block.type !== type || block.closed) { block = { type, lines: [] }; blocks.push(block); }
    block.lines.push(bullet ? bullet[1] : line);
  }
  return blocks.map(({ type, lines }) => ({ type, lines }));
}
