import { useCallback, useMemo, useState } from 'react';
import { Unlock } from 'lucide-react';
import ScientificText from '../ScientificText';
import { areaAccentForPaper, areaLabelForPaper } from '../../utils/areaAccent.js';
import { hasUsableAIAbstract } from '../../utils/aiExplanationAccess.js';
import { canHaveFigures } from '../../services/paperFigureService.js';
import { formeSeed, planForme } from '../../utils/researchForme.js';
import { useEditionFigures } from '../../hooks/useEditionFigures.js';

/**
 * The Research highlights, set as a newspaper forme.
 *
 * Layout lives in `researchForme.js`; this only dresses what it plans. The one
 * decision made here is when a cell reserves a well for a plate:
 *
 *   a paper that could have a figure keeps its well for as long as the answer
 *   is still outstanding, and gives the space back only once the edition has
 *   settled with nothing to put in it.
 *
 * So the page is built with the holes already in place and the pictures drop
 * into them as they arrive, rather than the grid rearranging itself around
 * every late answer. The well is grey until its image has actually decoded —
 * see `.is-loaded` — which is what stops a half-painted figure appearing.
 */

function Plate({ figure, aspect, isLoaded, onLoaded }) {
  return (
    <figure className={`sr-plate sr-plate--${aspect}${isLoaded ? ' is-loaded' : ''}`}>
      <span className="sr-plate-well">
        {figure && (
          <img
            src={figure.url}
            alt=""
            decoding="async"
            loading="lazy"
            /* A cached image can finish before React attaches `onLoad`, and then
               the event never comes and the well never stops being grey. The ref
               catches the ones already decoded on mount; `onLoad` catches the
               rest. Same guard the feed card uses. */
            ref={(node) => { if (node?.complete && node.naturalWidth > 0) onLoaded(figure.url); }}
            onLoad={() => onLoaded(figure.url)}
          />
        )}
      </span>
      {/* The paper's own caption, which is what the extractor returns. */}
      {figure?.caption && <figcaption className="sr-plate-caption">{figure.caption}</figcaption>}
    </figure>
  );
}

function FormeCell({ cell, figure, isLoaded, onLoaded, onSelect, enterOrder, isEnglish }) {
  const { paper, kind, span, isRowStart, isRowEnd, plate, aspect, titleSize, dekLines, twoColumnDek, rule, strip } = cell;
  /* Field and ink from the one shared resolution — arXiv category first, then
     the field OpenAlex itself declares, and only then the topic's name. Reading
     the name alone is what had the grid calling a paper mathematics while the
     card it opened called the same paper computer science: the topic
     "Mathematics, Computing, and Information Studies" is filed by OpenAlex
     under computer science, and no amount of reading its title says so. */
  const accent = areaAccentForPaper(paper);
  const category = areaLabelForPaper(paper, { english: isEnglish })
    || (isEnglish ? 'Research' : 'Investigación');

  const className = [
    'sr-cell',
    `sr-cell--s${span}`,
    `sr-cell--${kind}`,
    isRowStart ? 'is-row-start' : '',
    isRowEnd ? 'is-row-end' : '',
    'sr-enter',
  ].filter(Boolean).join(' ');

  const heading = (
    <>
      <div className="sr-cell-kicker">
        <span className="sr-cell-cat" style={{ color: accent }}>{category}</span>
        <span className="sr-cell-year">{paper.year}</span>
      </div>
      <h3 className={`sr-cell-title sr-cell-title--${titleSize}`} lang="en">
        <button
          type="button"
          className="sr-cell-title-btn"
          onClick={(e) => { e.stopPropagation(); onSelect(paper); }}
        >
          <ScientificText>{paper.title}</ScientificText>
        </button>
      </h3>
    </>
  );

  const dek = dekLines > 0 && (
    <p
      className={`sr-cell-dek${twoColumnDek ? ' sr-cell-dek--split' : ''}`}
      style={{ '--dek-lines': dekLines }}
      lang={hasUsableAIAbstract(paper.abstract) ? 'en' : undefined}
    >
      {hasUsableAIAbstract(paper.abstract)
        ? <ScientificText>{paper.abstract}</ScientificText>
        : (isEnglish ? 'Abstract unavailable.' : 'Resumen no disponible.')}
    </p>
  );

  const foot = (
    <div className="sr-cell-foot">
      {paper.openAccess && <span className="sr-micro oa"><Unlock size={11} /> Open Access</span>}
      {paper.citationCount > 0 && (
        <span className="sr-micro">{paper.citationCount} {isEnglish ? 'citations' : 'citas'}</span>
      )}
      {paper.journal && <span className="sr-micro venue" lang="en">{paper.journal}</span>}
    </div>
  );

  const plateNode = plate && (
    <Plate figure={figure} aspect={aspect} isLoaded={isLoaded} onLoaded={onLoaded} />
  );

  return (
    <article
      className={className}
      style={{ '--enter-order': enterOrder }}
      onClick={() => onSelect(paper)}
    >
      <span className="sr-cell-rule" style={{ background: accent }} aria-hidden="true" />
      {strip ? (
        <div className="sr-cell-strip">
          {plateNode}
          <div className="sr-cell-strip-body">
            {heading}
            {dek}
            {foot}
          </div>
        </div>
      ) : (
        <>
          {plateNode}
          {/* A full-width paper with no plate takes a heavy rule in its place,
              so the row still carries the weight the picture would have. */}
          {rule && <span className="sr-cell-heavy-rule" aria-hidden="true" />}
          {heading}
          {dek}
          {foot}
        </>
      )}
    </article>
  );
}

/** The same forme, with nothing in it yet. */
function SkeletonCell({ cell, enterOrder }) {
  const { span, kind, isRowStart, isRowEnd, plate, aspect, dekLines, strip } = cell;
  const className = [
    'sr-cell', 'sr-cell--skeleton', `sr-cell--s${span}`, `sr-cell--${kind}`,
    isRowStart ? 'is-row-start' : '', isRowEnd ? 'is-row-end' : '', 'sr-enter',
  ].filter(Boolean).join(' ');

  const bars = (
    <>
      <span className="sr-bone sr-bone--kicker" />
      <span className="sr-bone sr-bone--title" />
      <span className="sr-bone sr-bone--title sr-bone--short" />
      {dekLines > 0 && Array.from({ length: Math.min(dekLines, 3) }, (_, line) => (
        <span key={line} className={`sr-bone sr-bone--line${line === Math.min(dekLines, 3) - 1 ? ' sr-bone--short' : ''}`} />
      ))}
      <span className="sr-bone sr-bone--foot" />
    </>
  );

  return (
    <article className={className} style={{ '--enter-order': enterOrder }} aria-hidden="true">
      {strip ? (
        <div className="sr-cell-strip">
          <span className={`sr-plate sr-plate--${aspect} sr-plate--bone`} />
          <div className="sr-cell-strip-body">{bars}</div>
        </div>
      ) : (
        <>
          {plate && <span className={`sr-plate sr-plate--${aspect} sr-plate--bone`} />}
          {bars}
        </>
      )}
    </article>
  );
}

export default function ResearchForme({ papers, editionKey, loading, onSelect, enterFrom = 0, isEnglish }) {
  const list = useMemo(() => (papers || []).filter(Boolean), [papers]);
  const { figures, settled } = useEditionFigures(list);
  const [loadedPlates, setLoadedPlates] = useState(() => new Set());

  const markLoaded = useCallback((url) => {
    setLoadedPlates(current => (current.has(url) ? current : new Set(current).add(url)));
  }, []);

  const cells = useMemo(() => planForme(list, {
    seed: formeSeed(editionKey),
    wantsFigure: paper => canHaveFigures(paper),
    // The well is held open while the answer is outstanding and released only
    // once the edition has settled without one.
    hasFigure: paper => canHaveFigures(paper) && (figures.has(paper.id) || !settled),
  }), [list, editionKey, figures, settled]);

  if (cells.length === 0) return null;

  return (
    <div className={`sr-forme${loading ? ' is-recomposing' : ''}`}>
      {cells.map((cell, index) => {
        /* Capped: the cells below the fold gain nothing from a longer wait,
           and the page should feel settled by the time the reader gets there. */
        const enterOrder = enterFrom + Math.min(index, 7);
        if (loading) return <SkeletonCell key={cell.paper.id} cell={cell} enterOrder={enterOrder} />;
        const figure = figures.get(cell.paper.id) || null;
        return (
          <FormeCell
            key={cell.paper.id}
            cell={cell}
            figure={figure}
            isLoaded={Boolean(figure && loadedPlates.has(figure.url))}
            onLoaded={markLoaded}
            onSelect={onSelect}
            enterOrder={enterOrder}
            isEnglish={isEnglish}
          />
        );
      })}
    </div>
  );
}
