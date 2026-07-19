(function init(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.RemoteCodexMarkdownRenderer = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  function normalizeText(value) {
    return String(value == null ? '' : value).replace(/\r\n?/g, '\n');
  }

  function createMarkdownRenderer(options = {}) {
    const markdownItFactory = options.markdownIt
      || (typeof globalThis !== 'undefined' ? globalThis.markdownit : null);
    const sanitizer = options.sanitizer
      || (typeof globalThis !== 'undefined' ? globalThis.DOMPurify : null);
    const documentValue = options.document
      || (typeof document !== 'undefined' ? document : null);
    const parser = typeof markdownItFactory === 'function'
      ? markdownItFactory({
        html: false,
        breaks: false,
        linkify: true,
        typographer: false,
      })
      : null;

    function sanitize(html) {
      if (typeof sanitizer?.sanitize === 'function') {
        return sanitizer.sanitize(html, {
          USE_PROFILES: { html: true },
          FORBID_TAGS: ['style', 'form', 'input', 'textarea', 'select', 'option'],
          FORBID_ATTR: ['style', 'onerror', 'onload', 'onclick'],
        });
      }
      return null;
    }

    function decorateLinks(container) {
      for (const link of container.querySelectorAll('a[href]')) {
        let parsed;
        try {
          parsed = new URL(link.getAttribute('href'), 'https://remote-codex.invalid/');
        } catch {
          link.removeAttribute('href');
          continue;
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          link.removeAttribute('href');
          continue;
        }
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      }
    }

    function decorateCodeBlocks(container) {
      if (!documentValue) return;
      for (const pre of [...container.querySelectorAll('pre')]) {
        if (pre.closest('.markdown-code-card')) continue;
        const code = pre.querySelector(':scope > code');
        const languageClass = [...(code?.classList || [])]
          .find((value) => value.startsWith('language-'));
        const language = languageClass ? languageClass.slice('language-'.length) : 'code';
        const wrapper = documentValue.createElement('div');
        wrapper.className = 'markdown-code-card';
        const header = documentValue.createElement('div');
        header.className = 'markdown-code-header';
        const label = documentValue.createElement('span');
        label.textContent = language || 'code';
        const button = documentValue.createElement('button');
        button.type = 'button';
        button.className = 'markdown-copy-code secondary-button';
        button.dataset.copyText = code?.textContent || pre.textContent || '';
        button.textContent = 'Copy';
        header.append(label, button);
        pre.replaceWith(wrapper);
        wrapper.append(header, pre);
      }
    }

    function render(container, value) {
      if (!container) throw new TypeError('Markdown container is required');
      const source = normalizeText(value);
      container.replaceChildren();
      if (!parser || !sanitizer || !documentValue) {
        container.classList?.add('markdown-plain-fallback');
        container.textContent = source;
        return { rendered: false, fallback: true };
      }
      const clean = sanitize(parser.render(source));
      if (clean == null) {
        container.classList?.add('markdown-plain-fallback');
        container.textContent = source;
        return { rendered: false, fallback: true };
      }
      container.classList?.remove('markdown-plain-fallback');
      container.innerHTML = clean;
      decorateLinks(container);
      decorateCodeBlocks(container);
      return { rendered: true, fallback: false };
    }

    return { render };
  }

  let defaultRenderer = null;

  function render(container, value) {
    if (!defaultRenderer) defaultRenderer = createMarkdownRenderer();
    return defaultRenderer.render(container, value);
  }

  return {
    createMarkdownRenderer,
    render,
  };
}));
