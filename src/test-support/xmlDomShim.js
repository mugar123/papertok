/**
 * Enough of `DOMParser(text, 'text/xml')` for the parsers that read provider
 * XML (PubMed's efetch) to be tested under Node, which has no DOM: elements
 * with `tagName`, `getAttribute`, `textContent`, `children`, and
 * `querySelectorAll`/`querySelector` for type selectors joined by the
 * descendant (space) and child (`>`) combinators — the only selector shapes
 * those parsers use. Test-only: it lives outside `src/utils` so nothing in the
 * app can import it.
 */

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const code = entity[1].toLowerCase() === 'x'
        ? parseInt(entity.slice(2), 16)
        : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity] ?? match;
  });
}

class XmlElement {
  constructor(tagName, attributes = {}, parent = null) {
    this.tagName = tagName;
    this.attributes = attributes;
    this.parentNode = parent;
    this.childNodes = [];
  }

  get children() {
    return this.childNodes.filter((node) => node instanceof XmlElement);
  }

  get textContent() {
    return this.childNodes.map((node) => (typeof node === 'string' ? node : node.textContent)).join('');
  }

  getAttribute(name) {
    return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;
  }

  getElementsByTagName(name) {
    return descendants(this).filter((element) => name === '*' || element.tagName === name);
  }

  querySelectorAll(selector) {
    return queryAll(this, selector);
  }

  querySelector(selector) {
    return queryAll(this, selector)[0] || null;
  }
}

function descendants(root) {
  const found = [];
  const walk = (element) => {
    for (const child of element.children) {
      found.push(child);
      walk(child);
    }
  };
  walk(root);
  return found;
}

// "A > B C" → [{ tag: 'A' }, { tag: 'B', combinator: '>' }, { tag: 'C', combinator: ' ' }]
function parseSelector(selector) {
  const tokens = selector.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/);
  const steps = [];
  let combinator = ' ';
  for (const token of tokens) {
    if (token === '>') {
      combinator = '>';
      continue;
    }
    if (!/^[A-Za-z_*][\w.:-]*$/.test(token)) {
      throw new Error(`xmlDomShim supports type selectors only, not "${token}"`);
    }
    steps.push({ tag: token, combinator });
    combinator = ' ';
  }
  return steps;
}

function matchesTag(element, tag) {
  return tag === '*' || element.tagName === tag;
}

// Walks the steps right to left from a candidate, the way browsers do.
function matchesSteps(element, steps, index, scope) {
  if (!matchesTag(element, steps[index].tag)) return false;
  if (index === 0) return true;
  const { combinator } = steps[index];
  let ancestor = element.parentNode;
  while (ancestor && ancestor !== scope.parentNode) {
    if (matchesSteps(ancestor, steps, index - 1, scope)) return true;
    if (combinator === '>') return false;
    ancestor = ancestor.parentNode;
  }
  return false;
}

function queryAll(scope, selector) {
  return selector.split(',').flatMap((part) => {
    const steps = parseSelector(part);
    return descendants(scope).filter((element) => matchesSteps(element, steps, steps.length - 1, scope));
  });
}

const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<![^>]*>|<\?[\s\S]*?\?>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
const ATTRIBUTE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

export function parseXmlDocument(xmlText) {
  const documentNode = new XmlElement('#document');
  let current = documentNode;
  for (const match of String(xmlText).matchAll(TOKEN)) {
    const [, cdata, closing, opening, rawAttributes, selfClosing, text] = match;
    if (cdata !== undefined) {
      current.childNodes.push(cdata);
    } else if (closing) {
      if (current.tagName !== closing) throw new Error(`xmlDomShim: </${closing}> closes <${current.tagName}>`);
      current = current.parentNode;
    } else if (opening) {
      const attributes = {};
      for (const [, name, doubleQuoted, singleQuoted] of (rawAttributes || '').matchAll(ATTRIBUTE)) {
        attributes[name] = decodeEntities(doubleQuoted ?? singleQuoted ?? '');
      }
      const element = new XmlElement(opening, attributes, current);
      current.childNodes.push(element);
      if (!selfClosing) current = element;
    } else if (text !== undefined) {
      current.childNodes.push(decodeEntities(text));
    }
  }
  if (current !== documentNode) throw new Error(`xmlDomShim: <${current.tagName}> is never closed`);
  return documentNode;
}
