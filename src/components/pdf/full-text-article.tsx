import type { MouseEvent, ReactNode, RefObject } from 'react';
import type { Block, FullText, Inline, Reference } from '../../utils/full-text.ts';
import { blockInlines } from '../../utils/full-text.ts';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { getKatex, loadKatex } from '../../utils/katex-loader.ts';
import { safeDoiUrl } from '../../utils/external-url.ts';
import { getPublicPaperPath } from '../../utils/public-navigation.ts';
import { copyText } from '../../utils/clipboard.ts';
import { ArrowRight, ArrowSquareOut, Check, Copy, X } from '@phosphor-icons/react';
import { Button } from '../ui/button.tsx';
import { Popover, PopoverClose, PopoverPopup, PopoverPortal, PopoverPositioner, PopoverTitle } from '../ui/popover.tsx';
import type { Paper } from '../../models/paper.ts';
import { PaperByline } from './paper-byline.tsx';
import { anchor, anchorTarget, landOn } from './article-places.ts';
import { useScrollFrame } from './use-scroll-frame.ts';
import useIsPhone from '../../hooks/use-is-phone.ts';
import { Drawer, DrawerClose, DrawerContent, DrawerHandle, DrawerTitle } from '../ui/drawer.tsx';
import './full-text-article.css';
import { NewTabHint } from './new-tab-hint.tsx';


// Never navigates: a fragment in the address bar would fight useOverlayHistory for Back.
function jumpTo(event: MouseEvent<HTMLAnchorElement>, target: string) {
  event.preventDefault();
  const element = document.getElementById(anchor(target));
  if (element) landOn(element, element.offsetHeight > window.innerHeight * 0.8 ? 'start' : 'center');
}

const MAX_CACHED_FORMULAS = 2000;
const renderedFormulas = new Map<string, string | null>();

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

// Formulas drawn before KaTeX arrived are drawn again once it has.
const katexListeners = new Set<() => void>();
const subscribeKatex = (listener: () => void) => {
  katexListeners.add(listener);
  return () => { katexListeners.delete(listener); };
};
const katexReady = () => getKatex() !== null;

function Formula({ mathml, tex, image, display }: { mathml?: string; tex?: string; image?: string; display: boolean }) {
  useSyncExternalStore(subscribeKatex, katexReady);
  const html = katexHtml(tex, display) ?? mathml;
  if (html) return <span className="ft-math" dangerouslySetInnerHTML={{ __html: html }} />;
  if (image) return <img className="ft-formula-image" src={image} alt={tex ?? 'Formula'} loading="lazy" referrerPolicy="no-referrer" />;
  return tex ? <code className="ft-tex">{tex}</code> : null;
}

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

function Ref({ target, cites, children }: { target: string; cites?: true; children: ReactNode }) {
  return <a href={`#${anchor(target)}`} data-cites={cites} onClick={event => jumpTo(event, target)}>{children}</a>;
}

function Inlines({ content }: { content: Inline[] }) {
  return content.map((item, index) => {
    switch (item.t) {
      case 'text': return item.text;
      case 'math': return <Formula key={index} mathml={item.mathml} tex={item.tex} display={false} />;
      case 'formula-image': return <Formula key={index} image={item.src} display={false} />;
      case 'link': return <a key={index} href={item.href} target="_blank" rel="noopener noreferrer"><Inlines content={item.children} /></a>;
      case 'ref': return <Ref key={index} target={item.target} cites={item.cites}><Inlines content={item.children} /></Ref>;
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

function isNumeric(content: Inline[]) {
  const text = content.map(item => (item.t === 'text' ? item.text : item.t === 'math' ? '0' : '')).join('').trim();
  return /^[-+−±~≈<>]?\s*\d[\d.,\s]*(%|\s*±\s*[\d.,]+)?$/.test(text);
}

const referenceTitle = (reference: Reference) => reference.title || reference.text || reference.venue || '';

// A numbered reference reads "(26) 2016"; an author-year label already names a year, and keeps only its own.
function referenceMeta({ label, year }: Reference) {
  if (/^\d+$/.test(label)) return year ? `(${label}) ${year}` : `(${label})`;
  return year && !/\b(1[89]|20)\d{2}/.test(label) ? `${label} ${year}` : label;
}

const authorLine = (authors: string[], max: number) =>
  authors.length > max ? `${authors.slice(0, max).join(', ')} et al.` : authors.join(', ');

const referenceLinks = (reference: Reference) =>
  [
    reference.doi && { href: safeDoiUrl(reference.doi), text: `doi:${reference.doi}` },
    reference.pmid && { href: `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(reference.pmid)}/`, text: `PubMed ${reference.pmid}` },
    reference.arxiv && { href: `https://arxiv.org/abs/${encodeURIComponent(reference.arxiv)}`, text: `arXiv:${reference.arxiv}` },
    !reference.doi && !reference.arxiv && reference.url && { href: reference.url, text: 'Source' },
  ].filter((link): link is { href: string; text: string } => Boolean(link && link.href));

function ReferenceSource({ reference }: { reference: Reference }) {
  if (!reference.title) return null;
  return (
    <>
      {reference.authors.length > 0 && <span className="ft-ref-authors">{authorLine(reference.authors, 4)}</span>}
      {reference.venue && <span className="ft-ref-venue">{reference.venue}</span>}
    </>
  );
}

function ReferenceLinks({ reference }: { reference: Reference }) {
  const links = referenceLinks(reference);
  if (!links.length) return null;
  return (
    <span className="ft-ref-links">
      {links.map(link => (
        <a key={link.href} href={link.href} target="_blank" rel="noopener noreferrer">
          {link.text}<NewTabHint />
        </a>
      ))}
    </span>
  );
}

function ReferenceEntry({ reference }: { reference: Reference }) {
  const primary = referenceLinks(reference)[0];
  return (
    <>
      <span className="ft-ref-meta">{referenceMeta(reference)}</span>
      <span className="ft-ref-title">
        {primary
          ? <a className="ft-ref-card-link" href={primary.href} target="_blank" rel="noopener noreferrer">{referenceTitle(reference)}<NewTabHint /></a>
          : referenceTitle(reference)}
      </span>
      <ReferenceSource reference={reference} />
      <ReferenceLinks reference={reference} />
    </>
  );
}

// What a citation's card says, as a popover beside the citation or a sheet on a phone.
function ReferenceCard({ reference, lang, title, close }: { reference: Reference; lang?: string; title: ReactNode; close: ReactNode }) {
  const path = reference.arxiv || reference.doi || reference.pmid
    ? getPublicPaperPath({ arxivId: reference.arxiv, doi: reference.doi, pmid: reference.pmid })
    : null;
  return (
    <div className="ft-peek-card" lang={lang}>
      <div className="ft-peek-head">
        <span className="ft-ref-meta">{referenceMeta(reference)}</span>
        {close}
      </div>
      {title}
      <ReferenceSource reference={reference} />
      <ul className="ft-peek-links">
        {path && <li><a href={path} target="_blank" rel="noopener noreferrer"><span>PaperTok</span><ArrowRight size={14} aria-hidden="true" /><NewTabHint /></a></li>}
        {referenceLinks(reference).map(link => (
          <li key={link.href}><a href={link.href} target="_blank" rel="noopener noreferrer"><span>{link.text}</span><ArrowSquareOut size={14} aria-hidden="true" /><NewTabHint /></a></li>
        ))}
      </ul>
    </div>
  );
}

function ReferencePeek({ reference, open, onOpenChange, anchor, scroll, lang }: { reference: Reference | null; open: boolean; onOpenChange: (open: boolean) => void; anchor: RefObject<HTMLElement | null>; scroll: HTMLElement | null; lang?: string }) {
  const isPhone = useIsPhone();
  // Closed by scrolling away, focus stays where the reader is instead of pulling the text back.
  const scrolledAway = useRef(false);
  useEffect(() => {
    if (open) scrolledAway.current = false;
  }, [open]);
  useScrollFrame(open && !isPhone ? scroll : null, () => {
    const place = anchor.current?.getBoundingClientRect();
    const view = scroll?.getBoundingClientRect();
    if (!place || !view || (place.bottom > view.top && place.top < view.bottom)) return;
    scrolledAway.current = true;
    onOpenChange(false);
  });
  const closeButton = <Button variant="ghost" size="icon-sm" aria-label="Close" title="Close" />;
  if (isPhone) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent className="ft-sheet" overlayClassName="ft-sheet-backdrop" forceOverlay viewportClassName="ft-sheet-viewport" finalFocus={anchor}>
          <DrawerHandle />
          {reference && (
            <ReferenceCard
              reference={reference}
              lang={lang}
              title={<DrawerTitle render={<h2 />} className="ft-ref-title">{referenceTitle(reference)}</DrawerTitle>}
              close={<DrawerClose render={closeButton}><X size={14} aria-hidden="true" /></DrawerClose>}
            />
          )}
        </DrawerContent>
      </Drawer>
    );
  }
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverPortal>
        <PopoverPositioner anchor={anchor} side="top" align="center" sideOffset={8} collisionPadding={12} className="ft-peek-positioner">
          <PopoverPopup className="ft-peek" finalFocus={() => (scrolledAway.current ? false : anchor.current)}>
            {reference && (
              <ReferenceCard
                reference={reference}
                lang={lang}
                title={<PopoverTitle className="ft-ref-title">{referenceTitle(reference)}</PopoverTitle>}
                close={<PopoverClose render={closeButton}><X size={14} aria-hidden="true" /></PopoverClose>}
              />
            )}
          </PopoverPopup>
        </PopoverPositioner>
      </PopoverPortal>
    </Popover>
  );
}

type FigureBlock = Extract<Block, { t: 'figure' }>;

const figureAlt = (figure: FigureBlock, index: number) =>
  figure.images[index].alt ?? `${figure.label ?? 'Figure'}${figure.images.length > 1 ? `, part ${index + 1} of ${figure.images.length}` : ''}, described in the caption`;

function BlockView({ block }: { block: Block }): ReactNode {
  const id = 'id' in block && block.id ? anchor(block.id) : undefined;
  switch (block.t) {
    case 'heading': {
      const Tag = `h${Math.min(Math.max(block.level, 2), 4)}` as 'h2' | 'h3' | 'h4';
      return <Tag id={id} tabIndex={-1} className={block.level <= 2 ? 'ft-section' : 'ft-subsection'}><Label text={block.label} /><Inlines content={block.children} /></Tag>;
    }
    case 'p':
      return <p className="ft-p"><Inlines content={block.children} /></p>;
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
            <img key={index} src={image.src} alt={figureAlt(block, index)} loading="lazy" referrerPolicy="no-referrer" />
          ))}
          <figcaption><Label text={block.label} /><Inlines content={block.caption} /></figcaption>
        </figure>
      );
    case 'table':
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
  return doc.notes.some(note => hasTex(note.content))
    || [...doc.abstract, ...doc.body].some(block => (block.t === 'equation' ? Boolean(block.tex) : blockInlines(block).some(hasTex)));
}

export default function FullTextArticle({ doc, paper, showAbstract = true }: { doc: FullText; paper: Paper; showAbstract?: boolean }) {
  const wantsKatex = useMemo(() => needsKatex(doc), [doc]);
  useEffect(() => {
    if (!wantsKatex || getKatex()) return undefined;
    let active = true;
    void loadKatex().then(loaded => {
      if (active && loaded) katexListeners.forEach(notify => notify());
    });
    return () => { active = false; };
  }, [wantsKatex]);

  const references = useMemo(() => new Map(doc.references.map(reference => [reference.id, reference])), [doc]);

  const [shownReference, setShownReference] = useState<Reference | null>(null);
  const [referenceOpen, setReferenceOpen] = useState(false);
  const citation = useRef<HTMLElement | null>(null);
  const [citationScroll, setCitationScroll] = useState<HTMLElement | null>(null);
  const showReference = (event: MouseEvent<HTMLElement>) => {
    const link = (event.target as Element).closest<HTMLAnchorElement>('a[data-cites]');
    const reference = link && references.get(anchorTarget(link.getAttribute('href')!.slice(1)));
    if (!reference) return;
    event.preventDefault();
    event.stopPropagation();
    citation.current = link;
    setCitationScroll(link.closest<HTMLElement>('.ft-scroll'));
    setShownReference(reference);
    setReferenceOpen(true);
  };

  // Memoized apart, so showing the abstract or a citation's card does not re-render the whole paper.
  const head = useMemo(() => (
    <>
        <PaperByline paper={paper} />
        {doc.conversionErrors > 0 && (
          <p className="ft-warning">
            {doc.conversionErrors === 1 ? 'One part' : `${doc.conversionErrors} parts`} of this paper could not be converted to text. Switch to the PDF if something looks wrong.
          </p>
        )}
    </>
  ), [doc.conversionErrors, paper]);
  const abstract = useMemo(() => showAbstract && doc.abstract.length > 0 && (
    <section className="ft-abstract" aria-labelledby="ft-abstract-title">
      <h2 id="ft-abstract-title" className="ft-kicker" tabIndex={-1}>Abstract</h2>
      <div lang={doc.lang}>{doc.abstract.map((block, index) => <BlockView key={index} block={block} />)}</div>
    </section>
  ), [doc, showAbstract]);
  const body = useMemo(() => (
    <>
        {/* The paper's language marks its own text, not the reader's labels. */}
        <div lang={doc.lang}>{doc.body.map((block, index) => <BlockView key={index} block={block} />)}</div>
        {doc.notes.length > 0 && (
          <section className="ft-notes" aria-labelledby="ft-notes-title">
            <h2 id="ft-notes-title" className="ft-section" tabIndex={-1}>Notes</h2>
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
            <h2 id="ft-references-title" className="ft-section" tabIndex={-1}>References <span className="ft-count">{doc.references.length}</span></h2>
            <ol lang={doc.lang}>
              {doc.references.map(reference => (
                <li key={reference.id} id={anchor(reference.id)} tabIndex={-1}>
                  <ReferenceEntry reference={reference} />
                </li>
              ))}
            </ol>
          </section>
        )}
    </>
  ), [doc]);

  return (
    <article className="ft-article" onClickCapture={showReference}>
      {head}
      {abstract}
      {body}
      <ReferencePeek reference={shownReference} open={referenceOpen} onOpenChange={setReferenceOpen} anchor={citation} scroll={citationScroll} lang={doc.lang} />
    </article>
  );
}
