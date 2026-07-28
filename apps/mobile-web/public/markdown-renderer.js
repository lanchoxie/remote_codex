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

  function containsTexCommand(value) {
    const text = String(value || '');
    const knownCommand = /\\(?:alpha|beta|gamma|delta|epsilon|theta|lambda|mu|pi|rho|sigma|tau|phi|chi|psi|omega|Delta|Gamma|Theta|Lambda|Pi|Sigma|Phi|Psi|Omega|sum|prod|int|oint|frac|sqrt|text|textrm|textbf|mathrm|mathbf|mathit|mathcal|rm|left|right|rightarrow|leftarrow|leftrightarrow|Rightarrow|Leftarrow|cdot|times|div|pm|mp|leq?|geq?|neq|approx|equiv|infty|partial|nabla|overline|underline|hat|bar|vec|begin|end)\b/;
    if (knownCommand.test(text)) return true;
    return /\\[A-Za-z]+/.test(text)
      && /(?:[_^]\s*(?:\{[^}]*\}|[^\s])|\{[^}\n]+\})/.test(text);
  }

  function isIndentedCodePrefix(indent) {
    return String(indent || '').includes('\t') || String(indent || '').length >= 4;
  }

  function normalizeBareDisplayMath(value) {
    const lines = normalizeText(value).split('\n');
    const output = [];
    let fence = null;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
      if (fenceMatch) {
        const marker = fenceMatch[1];
        if (!fence) fence = { character: marker[0], length: marker.length };
        else if (marker[0] === fence.character && marker.length >= fence.length) fence = null;
        output.push(line);
        continue;
      }
      if (fence) {
        output.push(line);
        continue;
      }

      const sameLine = line.match(/^(\s*)\[\s*(.*?)\s*\]\s*$/);
      if (sameLine && !isIndentedCodePrefix(sameLine[1]) && containsTexCommand(sameLine[2])) {
        output.push(`${sameLine[1]}\\[`, sameLine[2], `${sameLine[1]}\\]`);
        continue;
      }

      const opening = line.match(/^(\s*)\[\s*(.*)$/);
      if (!opening || isIndentedCodePrefix(opening[1])) {
        output.push(line);
        continue;
      }
      let closingIndex = -1;
      let closingText = '';
      const maximumClosingIndex = Math.min(lines.length, index + 65);
      for (let candidate = index + 1; candidate < maximumClosingIndex; candidate += 1) {
        if (/^\s*(`{3,}|~{3,})/.test(lines[candidate])) break;
        const closing = lines[candidate].match(/^(.*?)\]\s*$/);
        if (closing) {
          closingIndex = candidate;
          closingText = closing[1];
          break;
        }
      }
      if (closingIndex < 0) {
        output.push(line);
        continue;
      }
      const bodyLines = [
        opening[2],
        ...lines.slice(index + 1, closingIndex),
        closingText,
      ];
      const body = bodyLines.join('\n').trim();
      if (!containsTexCommand(body)) {
        output.push(line);
        continue;
      }
      output.push(`${opening[1]}\\[`, body, `${opening[1]}\\]`);
      index = closingIndex;
    }
    return output.join('\n');
  }

  function installTexDelimiterRule(parser) {
    if (!parser?.inline?.ruler || !parser?.block?.ruler || !parser?.renderer?.rules) return;
    const findClosingDelimiter = (source, delimiter, start) => {
      let cursor = start;
      while (cursor < source.length) {
        const index = source.indexOf(delimiter, cursor);
        if (index < 0) return -1;
        let slashCount = 0;
        for (let offset = index - 1; offset >= 0 && source[offset] === '\\'; offset -= 1) {
          slashCount += 1;
        }
        const adjacentDollar = delimiter === '$'
          && (source[index - 1] === '$' || source[index + 1] === '$');
        if (slashCount % 2 === 0 && !adjacentDollar) return index;
        cursor = index + delimiter.length;
      }
      return -1;
    };
    parser.block.ruler.before('lheading', 'remote_codex_tex_block', (state, startLine, endLine, silent) => {
      const start = state.bMarks[startLine] + state.tShift[startLine];
      const firstLineEnd = state.eMarks[startLine];
      const firstLine = state.src.slice(start, firstLineEnd).trim();
      const opener = firstLine.startsWith('\\[')
        ? '\\['
        : firstLine.startsWith('$$')
          ? '$$'
          : '';
      if (!opener) return false;
      const closer = opener === '\\[' ? '\\]' : '$$';
      const sameLineClose = findClosingDelimiter(firstLine, closer, opener.length);
      let closingLine = sameLineClose >= 0 ? startLine : -1;
      for (let line = startLine + 1; closingLine < 0 && line < endLine; line += 1) {
        const lineStart = state.bMarks[line] + state.tShift[line];
        const lineText = state.src.slice(lineStart, state.eMarks[line]);
        if (findClosingDelimiter(lineText, closer, 0) >= 0) closingLine = line;
      }
      if (closingLine < 0) return false;
      if (silent) return true;
      const token = state.push('remote_codex_tex_block', '', 0);
      token.block = true;
      token.map = [startLine, closingLine + 1];
      token.content = state.src.slice(start, state.eMarks[closingLine]);
      token.markup = opener;
      state.line = closingLine + 1;
      return true;
    });
    parser.inline.ruler.before('escape', 'remote_codex_tex_delimiter', (state, silent) => {
      const pair = state.src.slice(state.pos, state.pos + 2);
      let opener = '';
      let closer = '';
      let display = false;
      if (pair === '\\[' || pair === '\\(') {
        opener = pair;
        closer = pair === '\\[' ? '\\]' : '\\)';
        display = pair === '\\[';
      } else if (pair === '$$') {
        opener = '$$';
        closer = '$$';
        display = true;
      } else if (state.src[state.pos] === '$' && state.src[state.pos + 1] !== '$') {
        opener = '$';
        closer = '$';
        if (/\s/.test(state.src[state.pos + 1] || '')) return false;
      } else {
        return false;
      }
      const end = findClosingDelimiter(state.src, closer, state.pos + opener.length);
      if (end < 0) return false;
      if (opener === '$' && /\s/.test(state.src[end - 1] || '')) return false;
      if (!silent) {
        const token = state.push('remote_codex_tex', '', 0);
        token.content = state.src.slice(state.pos, end + closer.length);
        token.meta = { display };
      }
      state.pos = end + closer.length;
      return true;
    });
    parser.renderer.rules.remote_codex_tex = (tokens, index) => {
      const token = tokens[index];
      const className = token.meta?.display ? 'markdown-math-block' : 'markdown-math-inline';
      return `<span class="${className}">${parser.utils.escapeHtml(token.content)}</span>`;
    };
    parser.renderer.rules.remote_codex_tex_block = (tokens, index) => (
      `<div class="markdown-math-block">${parser.utils.escapeHtml(tokens[index].content)}</div>\n`
    );
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
    installTexDelimiterRule(parser);

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
      const source = normalizeBareDisplayMath(value);
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
    normalizeBareDisplayMath,
    render,
  };
}));
