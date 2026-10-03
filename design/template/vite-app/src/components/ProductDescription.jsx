import React, { useMemo } from 'react';
import { descriptionBlocks } from './productDescriptionText.js';

const allowedTags = new Set(['p', 'div', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'ul', 'ol', 'li', 'blockquote', 'h3', 'h4', 'h5', 'h6', 'a']);
const blockedTags = new Set(['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'template', 'form', 'input', 'button', 'textarea', 'select']);

// Parse inert catalog HTML, then rebuild only supported formatting as React nodes.
// Catalog attributes, event handlers, styles, and executable markup are never rendered.
export function ProductDescription({ description }) {
  const content = useMemo(() => {
    if (!description) return null;
    if (!/<\/?[a-z][^>]*>/i.test(description)) return descriptionBlocks(description).map((block, index) => block.type === 'list'
      ? <ul key={index}>{block.lines.map((line, i) => <li key={i}>{line}</li>)}</ul>
      : <p key={index}>{block.lines.join('\n')}</p>);
    const template = document.createElement('template');
    template.innerHTML = description;
    function render(node, key) {
      if (node.nodeType === 3) return node.textContent;
      if (node.nodeType !== 1) return null;
      const tag = node.localName.toLowerCase();
      if (blockedTags.has(tag)) return null;
      const children = Array.from(node.childNodes, (child, index) => render(child, `${key}-${index}`));
      if (!allowedTags.has(tag)) return <React.Fragment key={key}>{children}</React.Fragment>;
      const props = { key };
      if (tag === 'a') {
        try {
          const url = new URL(node.getAttribute('href'), window.location.origin);
          if (node.hasAttribute('href') && ['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) {
            props.href = url.href;
            props.target = '_blank';
            props.rel = 'noopener noreferrer';
          }
        } catch { /* Keep the link text when its URL is invalid. */ }
      }
      return React.createElement(tag, props, ...(tag === 'br' ? [] : children));
    }
    return Array.from(template.content.childNodes, (node, index) => render(node, String(index)));
  }, [description]);
  return <div className="turkey-product-description">{content}</div>;
}
