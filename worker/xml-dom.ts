import { XMLParser } from 'fast-xml-parser';

// Enough of a parsed XML document for the readers written against the
// browser's DOMParser (src/utils/pubmedEfetch.ts) to run in the Worker, which
// has none: `textContent`, `getAttribute`, and `querySelector(All)` for type
// selectors joined by descendant (space) and child (`>`) combinators, the only
// selectors those readers use.

type OrderedNode = Record<string, unknown> & { ':@'?: Record<string, string>; '#text'?: unknown };

const PARSER = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: true,
  htmlEntities: true,
});

export class XmlElement {
  tagName: string;
  attributes: Record<string, string>;
  parent: XmlElement | null;
  childNodes: Array<string | XmlElement> = [];

  constructor(tagName: string, attributes: Record<string, string>, parent: XmlElement | null) {
    this.tagName = tagName;
    this.attributes = attributes;
    this.parent = parent;
  }

  get children() {
    return this.childNodes.filter((node): node is XmlElement => node instanceof XmlElement);
  }

  get textContent(): string {
    return this.childNodes.map(node => (typeof node === 'string' ? node : node.textContent)).join('');
  }

  getAttribute(name: string) {
    return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;
  }

  querySelectorAll(selector: string) {
    return queryAll(this, selector);
  }

  querySelector(selector: string) {
    return queryAll(this, selector)[0] || null;
  }
}

function build(nodes: OrderedNode[], parent: XmlElement) {
  for (const node of nodes) {
    if ('#text' in node) {
      parent.childNodes.push(String(node['#text']));
      continue;
    }
    const tagName = Object.keys(node).find(key => key !== ':@');
    if (!tagName || tagName.startsWith('?')) continue;
    const element = new XmlElement(tagName, node[':@'] || {}, parent);
    parent.childNodes.push(element);
    build((node[tagName] as OrderedNode[]) || [], element);
  }
}

function descendants(root: XmlElement) {
  const found: XmlElement[] = [];
  const walk = (element: XmlElement) => {
    for (const child of element.children) {
      found.push(child);
      walk(child);
    }
  };
  walk(root);
  return found;
}

function queryAll(root: XmlElement, selector: string) {
  const steps = selector.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/);
  let current = [root];
  let combinator = ' ';
  for (const step of steps) {
    if (step === '>') {
      combinator = '>';
      continue;
    }
    const next = new Set<XmlElement>();
    for (const element of current) {
      const pool = combinator === '>' ? element.children : descendants(element);
      for (const candidate of pool) if (candidate.tagName === step) next.add(candidate);
    }
    current = [...next];
    combinator = ' ';
  }
  return current;
}

/** The document as a root element whose children are the top-level elements. */
export function parseXmlDocument(xml: string) {
  const root = new XmlElement('#document', {}, null);
  build(PARSER.parse(xml) as OrderedNode[], root);
  return root;
}
