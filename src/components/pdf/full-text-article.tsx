import type { MouseEvent, ReactNode } from 'react';
import type { Block, FullText, Inline, Reference } from '../../utils/full-text.ts';
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { getKatex, loadKatex } from '../../utils/katex-loader.ts';
import { safeDoiUrl } from '../../utils/external-url.ts';
import { copyText } from '../../utils/clipboard.ts';
import { Check, Copy } from '@phosphor-icons/react';
import { Button } from '../ui/button.tsx';
import { Drawer, DrawerBody, DrawerContent, DrawerHandle, DrawerTitle } from '../ui/drawer.tsx';
import { Dialog, DialogContent } from '../ui/dialog.tsx';
import './full-text-article.css';

const SOURCE_NAME: Record<FullText['source'], string> = { arxiv: 'arXiv HTML', ar5iv: 'ar5iv', europepmc: 'Europe PMC' };
const anchor = (id: string) => `ft-${id}`;

// A citation or a "Figure 2" moves within the article. Following it as a link
// would put a fragment in the address bar, which the viewer's Back handling
// (useOverlayHistory) owns, so it never navigates, even to a target the
// article does not show (an affiliation, a footnote). The target lands in the
// middle of the screen, or at its top when it is nearly as tall as the screen.
function jumpTo(event: MouseEvent<HTMLAnchorElement>, target: string) {
  event.preventDefault();
  const element = document.getElementById(anchor(target));
  if (!element) return;
  element.scrollIntoView({ block: element.offsetHeight > window.innerHeight * 0.8 ? 'start' : 'center' });
  element.focus({ preventScroll: true });
  element.removeAttribute('data-landed');
  void element.offsetWidth;
  element.setAttribute('data-landed', '');
}

const MAX_CACHED_FORMULAS = 2000;
const renderedFormulas = new Map<string, string | null>();

// The paper's own TeX through KaTeX, as the reader's abstracts are drawn, or
// `null` when KaTeX is not loaded or cannot read it (a macro the paper defined
// itself); the formula's MathML is shown instead.
function katexHtml(tex: string | undefined, display: boolean) {
  const katex = getKatex();
  if (!katex || !tex) return null;
  const key = `${display ? 'D' : 'I'}\u0000${tex}`;
  if (!renderedFormulas.has(key)) {
    let html: string | null;
    try {
      html = katex.renderToString(tex, { displayMode: display, throwOnError: true, strict: 'ignore', trust: false });
    } catch {
      html = null;
    }
    if (renderedFormulas.size >= MAX_CACHED_FORMULAS) renderedFormulas.clear();
    renderedFormulas.set(key, html);
  }
  return renderedFormulas.get(key)!;
}

function Formula({ mathml, tex, image, display }: { mathml?: string; tex?: string; image?: string; display: boolean }) {
  // KaTeX's markup and MathML rebuilt from an allowlist in utils/full-text.ts.
  const html = katexHtml(tex, display) ?? mathml;
  if (html) return <span className="ft-math" dangerouslySetInnerHTML={{ __html: html }} />;
  if (image) return <img className="ft-formula-image" src={image} alt={tex ?? 'Formula'} loading="lazy" referrerPolicy="no-referrer" />;
  // TeX with no MathML, while KaTeX loads or when it cannot read it.
  return tex ? <code className="ft-tex">{tex}</code> : null;
}

// A formula's TeX when the paper has it, its MathML otherwise.
function CopyFormula({ tex, mathml }: { tex?: string; mathml?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => setState('idle'), 1500);
    return () => clearTimeout(timer);
  }, [state]);
  const text = tex ?? mathml;
  if (!text) return null;
  const label = tex ? 'Copy formula as LaTeX' : 'Copy formula as MathML';
  return (
    <>
      <Button variant="ghost" size="icon-sm" className="ft-copy" data-copied={state === 'copied' || undefined} aria-label={label} title={label} onClick={() => { void copyText(text).then(() => setState('copied'), () => setState('failed')); }}>
        {state === 'copied' ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
      </Button>
      <span className="visually-hidden" role="status">{state === 'copied' ? 'Formula copied' : state === 'failed' ? 'Could not copy the formula' : ''}</span>
    </>
  );
}

function Inlines({ content }: { content: Inline[] }) {
  return content.map((item, index) => {
    switch (item.t) {
      case 'text': return item.text;
      case 'math': return <Formula key={index} mathml={item.mathml} tex={item.tex} display={false} />;
      case 'formula-image': return <Formula key={index} image={item.src} display={false} />;
      case 'link': return <a key={index} href={item.href} target="_blank" rel="noopener noreferrer"><Inlines content={item.children} /></a>;
      case 'ref': return <a key={index} href={`#${anchor(item.target)}`} onClick={event => jumpTo(event, item.target)}><Inlines content={item.children} /></a>;
      case 'em': return <em key={index}><Inlines content={item.children} /></em>;
      case 'strong': return <strong key={index}><Inlines content={item.children} /></strong>;
      case 'sup': return <sup key={index}><Inlines content={item.children} /></sup>;
      case 'sub': return <sub key={index}><Inlines content={item.children} /></sub>;
      case 'code': return <code key={index}><Inlines content={item.children} /></code>;
    }
  });
}

function Label({ text }: { text?: string }) {
  return text ? <span className="ft-label">{text}</span> : null;
}

/** Whether a cell reads as a number, so it aligns on the right with its column. */
function isNumeric(content: Inline[]) {
  const text = content.map(item => (item.t === 'text' ? item.text : item.t === 'math' ? '0' : '')).join('').trim();
  return /^[-+−±~≈<>]?\s*\d[\d.,\s]*(%|\s*±\s*[\d.,]+)?$/.test(text);
}

function citedIn(content: Inline[], into: string[] = []) {
  for (const item of content) {
    if (item.t === 'ref') into.push(item.target);
    if ('children' in item) citedIn(item.children, into);
  }
  return into;
}

// What names a reference in a list: its title, or its whole line, or at least where it appeared.
const referenceTitle = (reference: Reference) => reference.title || reference.text || reference.venue || '';

const authorLine = (authors: string[], max: number) =>
  authors.length > max ? `${authors.slice(0, max).join(', ')} et al.` : authors.join(', ');

const referenceLinks = (reference: Reference) =>
  [
    reference.doi && { href: safeDoiUrl(reference.doi), text: `doi:${reference.doi}` },
    reference.pmid && { href: `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(reference.pmid)}/`, text: `PubMed ${reference.pmid}` },
    reference.arxiv && { href: `https://arxiv.org/abs/${encodeURIComponent(reference.arxiv)}`, text: `arXiv:${reference.arxiv}` },
    !reference.doi && !reference.arxiv && reference.url && { href: reference.url, text: 'Link' },
  ].filter((link): link is { href: string; text: string } => Boolean(link && link.href));

function ReferenceLinks({ reference }: { reference: Reference }) {
  const links = referenceLinks(reference);
  if (!links.length) return null;
  return (
    <span className="ft-ref-links">
      {links.map(link => (
        <a key={link.href} href={link.href} target="_blank" rel="noopener noreferrer">
          {link.text}<span className="visually-hidden"> (opens in a new tab)</span>
        </a>
      ))}
    </span>
  );
}

// A reference as the list prints it; the drawer shows the same on a screen with no margin.
// In the list its title links the whole card to the reference's first identifier.
function ReferenceEntry({ reference, title }: { reference: Reference; title?: ReactNode }) {
  const primary = referenceLinks(reference)[0];
  return (
    <>
      <span className="ft-ref-meta">{reference.label}{reference.year ? ` · ${reference.year}` : ''}</span>
      {title ?? (
        <span className="ft-ref-title">
          {primary
            ? <a className="ft-ref-card-link" href={primary.href} target="_blank" rel="noopener noreferrer">{referenceTitle(reference)}<span className="visually-hidden"> (opens in a new tab)</span></a>
            : referenceTitle(reference)}
        </span>
      )}
      {reference.title && reference.authors.length > 0 && <span className="ft-ref-authors">{authorLine(reference.authors, 4)}</span>}
      {reference.title && reference.venue && <span className="ft-ref-venue">{reference.venue}</span>}
      <ReferenceLinks reference={reference} />
    </>
  );
}

type FigureBlock = Extract<Block, { t: 'figure' }>;
type ZoomedFigure = { figure: FigureBlock; index: number };
type Context = { references: Map<string, Reference>; lang?: string; zoom: (zoomed: ZoomedFigure, opener: HTMLElement) => void };

const figureAlt = (figure: FigureBlock, index: number) =>
  figure.images[index].alt ?? `${figure.label ?? 'Figure'}${figure.images.length > 1 ? `, part ${index + 1} of ${figure.images.length}` : ''}, described in the caption`;

function BlockView({ block, context }: { block: Block; context: Context }): ReactNode {
  const id = 'id' in block && block.id ? anchor(block.id) : undefined;
  switch (block.t) {
    case 'heading': {
      const Tag = `h${Math.min(Math.max(block.level, 2), 4)}` as 'h2' | 'h3' | 'h4';
      return <Tag id={id} tabIndex={-1} className={block.level <= 2 ? 'ft-section' : 'ft-subsection'}><Label text={block.label} /><Inlines content={block.children} /></Tag>;
    }
    case 'p': {
      const paragraph = <p className="ft-p"><Inlines content={block.children} /></p>;
      const cited = [...new Set(citedIn(block.children))]
        .map(target => context.references.get(target))
        .filter((reference): reference is Reference => Boolean(reference));
      if (!cited.length) return paragraph;
      // A paragraph's sources beside it, on a screen wide enough for a margin.
      return (
        <div className="ft-margin-row">
          {paragraph}
          {/* Not a landmark: a paper with sixty cited paragraphs would list sixty. */}
          <div className="ft-margin-notes">
            {cited.map(reference => (
              <a key={reference.id} href={`#${anchor(reference.id)}`} onClick={event => jumpTo(event, reference.id)} className="ft-margin-note" lang={context.lang}>
                <span className="ft-ref-meta">{reference.label}{reference.year ? ` · ${reference.year}` : ''}</span>
                <span className="ft-margin-note-title">{referenceTitle(reference)}</span>
                {reference.title && reference.authors.length > 0 && <span className="ft-ref-authors">{authorLine(reference.authors, 2)}</span>}
              </a>
            ))}
          </div>
        </div>
      );
    }
    case 'equation':
      return (
        <div id={id} tabIndex={-1} className="ft-equation">
          <Formula mathml={block.mathml} tex={block.tex} image={block.image} display />
          <Label text={block.label} />
          <CopyFormula tex={block.tex} mathml={block.mathml} />
        </div>
      );
    case 'list': {
      const List = block.ordered ? 'ol' : 'ul';
      return <List className="ft-list">{block.items.map((item, index) => <li key={index}><Inlines content={item} /></li>)}</List>;
    }
    case 'figure':
      return (
        <figure id={id} tabIndex={-1} className="ft-figure">
          {block.images.map((image, index) => (
            <button key={index} type="button" className="ft-figure-zoom" onClick={event => context.zoom({ figure: block, index }, event.currentTarget)}>
              <img src={image.src} alt={figureAlt(block, index)} loading="lazy" referrerPolicy="no-referrer" />
              <span className="visually-hidden"> (enlarge)</span>
            </button>
          ))}
          <figcaption><Label text={block.label} /><Inlines content={block.caption} /></figcaption>
        </figure>
      );
    case 'table':
      // A wide table takes the width it needs beyond the text column, with its
      // header row kept in view while it scrolls.
      return (
        <figure id={id} tabIndex={-1} className="ft-table">
          {block.caption.length > 0 && <figcaption><Label text={block.label} /><Inlines content={block.caption} /></figcaption>}
          <div className="ft-table-scroll" tabIndex={0} role="region" aria-label={block.label ?? 'Table'}>
            <table>
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, cellIndex) => {
                      const Cell = cell.header ? 'th' : 'td';
                      return (
                        <Cell key={cellIndex} colSpan={cell.colSpan} rowSpan={cell.rowSpan} data-numeric={!cell.header && isNumeric(cell.content) ? '' : undefined}>
                          <Inlines content={cell.content} />
                        </Cell>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </figure>
      );
  }
}

const hasTex = (content: Inline[]): boolean =>
  content.some(item => (item.t === 'math' && Boolean(item.tex)) || ('children' in item && hasTex(item.children)));

function needsKatex(doc: FullText) {
  if (doc.notes.some(note => hasTex(note.content))) return true;
  return [...doc.abstract, ...doc.body].some(block => {
    if (block.t === 'equation') return Boolean(block.tex);
    if (block.t === 'p' || block.t === 'heading') return hasTex(block.children);
    if (block.t === 'list') return block.items.some(hasTex);
    if (block.t === 'figure' || block.t === 'table') return hasTex(block.caption) || (block.t === 'table' && block.rows.some(row => row.some(cell => hasTex(cell.content))));
    return false;
  });
}

/** A paper's full text in the reader's type: the viewer's text view. */
export default function FullTextArticle({ doc }: { doc: FullText }) {
  const [, katexLoaded] = useReducer((count: number) => count + 1, 0);
  const wantsKatex = useMemo(() => needsKatex(doc), [doc]);
  useEffect(() => {
    if (!wantsKatex || getKatex()) return undefined;
    let active = true;
    void loadKatex().then(loaded => {
      if (active && loaded) katexLoaded();
    });
    return () => { active = false; };
  }, [wantsKatex]);

  // What a dialog shows outlives its being open, so it leaves with its content.
  const [zoomed, setZoomed] = useState<ZoomedFigure | null>(null);
  const [zoomOpen, setZoomOpen] = useState(false);
  const zoomOpener = useRef<HTMLElement | null>(null);
  const zoomPopup = useRef<HTMLElement | null>(null);
  // The enlarged figure grows out of the one in the text, and shrinks back into it.
  // Measured on the image, not the dialog around it: the caption below would
  // otherwise start it above the figure and smaller. An image not yet laid out
  // grows from the dialog's centre instead. Measured again on close, where the
  // dialog may have been scrolled.
  const growFromOpener = (popup: HTMLElement | null) => {
    zoomPopup.current = popup;
    const from = zoomOpener.current?.querySelector('img')?.getBoundingClientRect();
    if (!popup || !from) return;
    const image = popup.querySelector<HTMLElement>('figure img');
    const target = image?.offsetWidth && image.offsetHeight ? image : popup;
    const centerX = target === popup ? popup.offsetWidth / 2 : target.offsetLeft + target.offsetWidth / 2;
    const centerY = target === popup ? popup.offsetHeight / 2 : target.offsetTop - popup.scrollTop + target.offsetHeight / 2;
    const left = (window.innerWidth - popup.offsetWidth) / 2;
    const top = (window.innerHeight - popup.offsetHeight) / 2;
    popup.style.transformOrigin = `${centerX}px ${centerY}px`;
    popup.style.setProperty('--zoom-x', `${from.left + from.width / 2 - (left + centerX)}px`);
    popup.style.setProperty('--zoom-y', `${from.top + from.height / 2 - (top + centerY)}px`);
    popup.style.setProperty('--zoom-scale', String(Math.min(from.width / target.offsetWidth, 1)));
  };
  // The figure in the text fades into the one growing out of it, and comes back
  // once the enlarged one has landed on it.
  const setZoom = (open: boolean) => {
    if (open) zoomOpener.current?.setAttribute('data-zoomed', '');
    else growFromOpener(zoomPopup.current);
    setZoomOpen(open);
  };
  const zoomSettled = (open: boolean) => {
    if (!open) zoomOpener.current?.removeAttribute('data-zoomed');
  };
  const context = useMemo<Context>(() => ({
    references: new Map(doc.references.map(reference => [reference.id, reference])),
    lang: doc.lang,
    zoom: (figure, opener) => {
      zoomOpener.current = opener;
      opener.setAttribute('data-zoomed', '');
      setZoomed(figure);
      setZoomOpen(true);
    },
  }), [doc]);

  // Below the margin's breakpoint (full-text-article.css), a citation opens its
  // reference in a sheet instead of jumping to the list, and focus returns to it.
  const [shownReference, setShownReference] = useState<Reference | null>(null);
  const [referenceOpen, setReferenceOpen] = useState(false);
  const citation = useRef<HTMLElement | null>(null);
  const showReference = (event: MouseEvent<HTMLElement>) => {
    const link = (event.target as Element).closest<HTMLAnchorElement>('a[href^="#ft-"]');
    const reference = link && context.references.get(link.getAttribute('href')!.slice(4));
    if (!reference || window.matchMedia('(min-width: 1280px)').matches) return;
    event.preventDefault();
    event.stopPropagation();
    citation.current = link;
    setShownReference(reference);
    setReferenceOpen(true);
  };

  return (
    <article className="ft-article" onClickCapture={showReference}>
      <p className="ft-kicker">
        {SOURCE_NAME[doc.source]}
        {doc.license && <> · {doc.license.replace(/^https?:\/\//, '').replace(/\/$/, '')}</>}
        {' · '}<a href={doc.sourceUrl} target="_blank" rel="noopener noreferrer">Original<span className="visually-hidden"> (opens in a new tab)</span></a>
      </p>
      {doc.conversionErrors > 0 && (
        <p className="ft-warning">
          {doc.conversionErrors === 1 ? 'One part' : `${doc.conversionErrors} parts`} of this paper could not be converted to text. Switch to the PDF if something looks wrong.
        </p>
      )}
      {doc.abstract.length > 0 && (
        <section className="ft-abstract" aria-labelledby="ft-abstract-title">
          <h2 id="ft-abstract-title" className="ft-kicker">Abstract</h2>
          <div lang={doc.lang}>{doc.abstract.map((block, index) => <BlockView key={index} block={block} context={context} />)}</div>
        </section>
      )}
      {/* The paper's language marks its own text, not the reader's labels. */}
      <div lang={doc.lang}>{doc.body.map((block, index) => <BlockView key={index} block={block} context={context} />)}</div>
      {doc.notes.length > 0 && (
        <section className="ft-notes" aria-labelledby="ft-notes-title">
          <h2 id="ft-notes-title" className="ft-section">Notes</h2>
          <ol lang={doc.lang}>
            {doc.notes.map(note => (
              <li key={note.id} id={anchor(note.id)} tabIndex={-1}>
                <span className="ft-ref-meta">{note.label}</span>
                <span><Inlines content={note.content} /></span>
              </li>
            ))}
          </ol>
        </section>
      )}
      {doc.references.length > 0 && (
        <section className="ft-references" aria-labelledby="ft-references-title">
          <h2 id="ft-references-title" className="ft-section">References <span className="ft-count">{doc.references.length}</span></h2>
          <ol lang={doc.lang}>
            {doc.references.map(reference => (
              <li key={reference.id} id={anchor(reference.id)} tabIndex={-1}>
                <ReferenceEntry reference={reference} />
              </li>
            ))}
          </ol>
        </section>
      )}
      <Dialog open={zoomOpen} onOpenChange={setZoom} onOpenChangeComplete={zoomSettled}>
        <DialogContent className="ft-zoom" overlayClassName="ft-zoom-scrim" closeLabel="Close figure" finalFocus={zoomOpener} aria-label={zoomed?.figure.label ?? 'Figure'} ref={growFromOpener}>
          {zoomed && (
            <figure lang={doc.lang}>
              <img src={zoomed.figure.images[zoomed.index].src} alt={figureAlt(zoomed.figure, zoomed.index)} referrerPolicy="no-referrer" />
              <figcaption><Label text={zoomed.figure.label} /><Inlines content={zoomed.figure.caption} /></figcaption>
            </figure>
          )}
        </DialogContent>
      </Dialog>
      <Drawer open={referenceOpen} onOpenChange={setReferenceOpen}>
        <DrawerContent className="ft-ref-sheet" overlayClassName="ft-ref-sheet-backdrop" viewportClassName="ft-ref-sheet-viewport" finalFocus={citation}>
          <DrawerHandle />
          {shownReference && (
            <DrawerBody className="ft-ref-sheet-body" lang={doc.lang}>
              <ReferenceEntry reference={shownReference} title={<DrawerTitle render={<h2 />} className="ft-ref-title">{referenceTitle(shownReference)}</DrawerTitle>} />
            </DrawerBody>
          )}
        </DrawerContent>
      </Drawer>
    </article>
  );
}
