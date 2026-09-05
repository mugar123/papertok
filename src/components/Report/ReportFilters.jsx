import { useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Collapsible } from '@base-ui/react/collapsible';
import { CATEGORIES } from '../../data/categories';
import { getCountryName, searchCountries } from '../../data/countries';
import { Check, ChevronDown, LoaderCircle, MapPin, Search, X } from 'lucide-react';
import WorldMap from './WorldMap';
import { Button } from '../ui/button.jsx';
import { Input } from '../ui/input.jsx';
import { Toggle } from '../ui/toggle.jsx';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group.jsx';
import { useLanguage } from '../../context/LanguageContext';
import './ReportFilters.css';

const EASE = [0.16, 1, 0.3, 1];
const QUICK_COUNTRIES = ['US', 'GB', 'DE', 'FR', 'CN', 'JP', 'ES', 'CA'];

/* A discipline pill that framer can stagger in and press: the ui toggle-group
   item forwards its ref, which is all `motion.create` needs. */
const MotionToggleGroupItem = motion.create(ToggleGroupItem);

function normalizeFilters(filters = {}) {
  return {
    categories: [...new Set(filters.categories || [])],
    countries: [...new Set(filters.countries || [])],
  };
}

function filterKey(filters = {}) {
  const normalized = normalizeFilters(filters);
  return JSON.stringify({
    categories: [...normalized.categories].sort(),
    countries: [...normalized.countries].sort(),
  });
}

/**
 * Smooth expand/collapse for a block of content: a Base UI Collapsible panel.
 * The primitive measures the content into `--collapsible-panel-height` and
 * marks the first and last frames with `data-starting-style` /
 * `data-ending-style`; the fold itself — the two different curves of opening
 * and closing — is written on `.rf-collapse` in the stylesheet, and the panel
 * stays mounted until the exit transition ends.
 */
function Collapse({ children, id }) {
  return (
    <Collapsible.Panel id={id} className="rf-collapse">
      {children}
    </Collapsible.Panel>
  );
}

function Chevron({ isOpen, size = 16, reduced }) {
  return (
    <motion.span
      className="rf-chevron"
      animate={{ rotate: isOpen ? 180 : 0 }}
      transition={reduced ? { duration: 0 } : { duration: 0.25, ease: EASE }}
      aria-hidden="true"
    >
      <ChevronDown size={size} />
    </motion.span>
  );
}

export default function ReportFilters({ filters, onChange, loading = false }) {
  const { language, isEnglish } = useLanguage();
  const [isOpen, setIsOpen] = useState(false);
  const [isCountryOpen, setIsCountryOpen] = useState(() => (filters.countries?.length || 0) > 0);
  const [countrySearch, setCountrySearch] = useState('');
  const [draftFilters, setDraftFilters] = useState(() => normalizeFilters(filters));
  const countryInputRef = useRef(null);
  const reduced = useReducedMotion();

  const areaKeys = Object.keys(CATEGORIES);
  const appliedFilters = useMemo(() => normalizeFilters(filters), [filters]);
  const appliedKey = useMemo(() => filterKey(appliedFilters), [appliedFilters]);
  const draftKey = useMemo(() => filterKey(draftFilters), [draftFilters]);
  const hasPendingChanges = appliedKey !== draftKey;

  const searchResults = useMemo(() => (
    searchCountries(countrySearch, language)
  ), [countrySearch, language]);

  const toggleDraftValue = (field, value) => {
    setDraftFilters(current => {
      const values = current[field] || [];
      return {
        ...current,
        [field]: values.includes(value)
          ? values.filter(item => item !== value)
          : [...values, value],
      };
    });
  };

  /* The discipline group hands back the whole pressed set. */
  const setCategories = (categories) => {
    setDraftFilters(current => ({ ...current, categories: [...categories] }));
  };

  const toggleCountry = (code) => {
    toggleDraftValue('countries', code);
    setCountrySearch('');
    countryInputRef.current?.blur();
  };

  const removeAppliedValue = (field, value) => {
    const next = {
      ...appliedFilters,
      [field]: appliedFilters[field].filter(item => item !== value),
    };
    onChange(next);
  };

  const closePanel = () => {
    setDraftFilters(appliedFilters);
    setCountrySearch('');
    setIsOpen(false);
  };

  const openPanel = () => {
    setDraftFilters(appliedFilters);
    setIsOpen(true);
  };

  /* The Collapsible reports the next state (trigger, keyboard); opening seeds
     the draft from what is applied, closing throws the draft away. */
  const handlePanelOpenChange = (open) => {
    if (open) openPanel();
    else closePanel();
  };

  const applyFilters = () => {
    if (!hasPendingChanges || loading) return;
    onChange(normalizeFilters(draftFilters));
    setCountrySearch('');
    setIsOpen(false);
  };

  const activeCategories = draftFilters.categories;
  const activeCountries = draftFilters.countries;
  const appliedCount = appliedFilters.categories.length + appliedFilters.countries.length;
  const draftCount = activeCategories.length + activeCountries.length;

  return (
    // The block is a Base UI Collapsible: the row is its trigger (Base UI
    // writes `aria-expanded`, `aria-controls` and `data-panel-open` on it) and
    // the panel below folds on a CSS transition.
    <Collapsible.Root className="rf" open={isOpen} onOpenChange={handlePanelOpenChange}>
      {/* The row reads as the twin of the EDITION row above it: a mono label,
          the state set in running text, and one hairline rule underneath. */}
      <Collapsible.Trigger
        render={<button type="button" className="rf-toggle" />}
      >
        <span className="rf-toggle-label">{isEnglish ? 'Filters' : 'Filtros'}</span>
        <span className={`rf-toggle-summary ${appliedCount > 0 ? '' : 'is-empty'}`}>
          {appliedCount > 0 ? (
            <>
              <span className="rf-toggle-count">{appliedCount}</span>
              {isEnglish ? ' active' : ' activos'}
            </>
          ) : (
            isEnglish ? 'All disciplines and countries' : 'Todas las disciplinas y países'
          )}
        </span>
        <span className="rf-toggle-status">
          {loading && <LoaderCircle className="rf-loading-icon" size={14} aria-hidden="true" />}
          <span className="rf-toggle-action">
            {isOpen
              ? (isEnglish ? 'Close' : 'Cerrar')
              : (isEnglish ? 'Refine' : 'Afinar')}
          </span>
          <Chevron isOpen={isOpen} reduced={reduced} />
        </span>
        {/* The rule under this row is the one that sweeps while the edition
            compiles. It used to be a second rule drawn along the top of the
            body, which spanned both columns and landed on the sidebar's
            numbers — a line that only existed while loading. */}
        {loading && <span className="rf-sweep" aria-hidden="true" />}
      </Collapsible.Trigger>

      <AnimatePresence initial={false}>
        {!isOpen && appliedCount > 0 && (
          <motion.div
            className="rf-active-row"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={reduced ? { duration: 0 } : { duration: 0.25, ease: EASE }}
            style={{ overflow: 'hidden' }}
          >
            <div className="rf-active-chips" aria-label={isEnglish ? 'Active filters' : 'Filtros activos'}>
              {appliedFilters.categories.map(key => (
                <button
                  type="button"
                  key={key}
                  className="rf-active-chip"
                  onClick={() => removeAppliedValue('categories', key)}
                  aria-label={`${isEnglish ? 'Remove' : 'Quitar'} ${(isEnglish ? CATEGORIES[key]?.labelEn : CATEGORIES[key]?.label) || key}`}
                >
                  {(isEnglish ? CATEGORIES[key]?.labelEn : CATEGORIES[key]?.label) || key} <X size={11} />
                </button>
              ))}
              {appliedFilters.countries.map(code => (
                <button
                  type="button"
                  key={code}
                  className="rf-active-chip"
                  onClick={() => removeAppliedValue('countries', code)}
                  aria-label={`${isEnglish ? 'Remove' : 'Quitar'} ${getCountryName(code, language)}`}
                >
                  {getCountryName(code, language)} <X size={11} />
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <Collapse id="rf-panel">
        <div className="rf-panel">
          <div className="rf-section">
            <span className="rf-section-label">{isEnglish ? 'Discipline' : 'Disciplina'}</span>
            {/* A multi-select ToggleGroup (`aria-pressed` on every pill, arrow
                keys between them); the stagger and the press stay framer's,
                on the items. `outline` so the group draws no track of its own. */}
            <ToggleGroup
              multiple
              variant="outline"
              className="rf-pills"
              value={activeCategories}
              onValueChange={setCategories}
              aria-label={isEnglish ? 'Discipline' : 'Disciplina'}
              render={(
                <motion.div
                  initial={reduced ? false : 'hidden'}
                  animate="visible"
                  variants={{ visible: { transition: { staggerChildren: 0.012 } } }}
                />
              )}
            >
              {areaKeys.map(key => {
                const area = CATEGORIES[key];
                const Icon = area.icon;
                const isActive = activeCategories.includes(key);
                const label = isEnglish ? area.labelEn : area.label;
                return (
                  <MotionToggleGroupItem
                    key={key}
                    value={key}
                    className="rf-pill"
                    aria-label={`${isActive ? (isEnglish ? 'Remove' : 'Quitar') : (isEnglish ? 'Add' : 'Añadir')} ${label}`}
                    style={isActive ? { '--rf-pill-accent': area.gradient } : undefined}
                    variants={{
                      hidden: { opacity: 0, y: 6 },
                      visible: { opacity: 1, y: 0, transition: { duration: 0.2, ease: EASE } },
                    }}
                    whileTap={reduced ? undefined : { scale: 0.96 }}
                  >
                    {isActive && <Check size={12} aria-hidden="true" />}
                    {!isActive && <Icon size={13} aria-hidden="true" />}
                    {label}
                  </MotionToggleGroupItem>
                );
              })}
            </ToggleGroup>
          </div>

          {/* `--country` carries no gap: see the note on the rule. The space
              between the toggle and the block below it has to live *inside*
              the block, or it vanishes in one frame when the block unmounts. */}
          {/* A Collapsible of its own, nested in the panel's. */}
          <Collapsible.Root
            className="rf-section rf-section--country"
            open={isCountryOpen}
            onOpenChange={setIsCountryOpen}
          >
            <Collapsible.Trigger render={<button type="button" className="rf-country-toggle" />}>
              <span><MapPin size={13} /> {isEnglish ? 'Affiliation country' : 'País de afiliación'}{activeCountries.length ? ` (${activeCountries.length})` : ''}</span>
              <Chevron isOpen={isCountryOpen} size={15} reduced={reduced} />
            </Collapsible.Trigger>

            <Collapse id="rf-country-controls">
              <div className="rf-country-controls">
                <p className="rf-country-note">
                  {isEnglish
                    ? 'Country results use normalized OpenAlex affiliations.'
                    : 'Los resultados por país usan afiliaciones normalizadas de OpenAlex.'}
                </p>

                <div className="rf-search-wrap">
                  <Search size={15} className="rf-search-icon" aria-hidden="true" />
                  <Input
                    ref={countryInputRef}
                    className="rf-search"
                    type="search"
                    aria-label={isEnglish ? 'Search affiliation country' : 'Buscar país de afiliación'}
                    autoComplete="off"
                    placeholder={isEnglish ? 'Search country...' : 'Buscar país...'}
                    value={countrySearch}
                    onChange={(event) => setCountrySearch(event.target.value)}
                  />
                  {countrySearch && (
                    <button
                      type="button"
                      className="rf-search-clear"
                      onClick={() => setCountrySearch('')}
                      aria-label={isEnglish ? 'Clear country search' : 'Borrar búsqueda de país'}
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>

                <AnimatePresence mode="wait">
                  {countrySearch && searchResults.length > 0 && (
                    <motion.div
                      key="results"
                      className="rf-search-results"
                      role="listbox"
                      aria-label={isEnglish ? 'Country results' : 'Resultados de países'}
                      initial={reduced ? false : { opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={reduced ? { opacity: 0 } : { opacity: 0, y: -4 }}
                      transition={{ duration: 0.16, ease: EASE }}
                    >
                      {searchResults.map(({ code, name }) => {
                        const selected = activeCountries.includes(code);
                        return (
                          <button
                            type="button"
                            role="option"
                            aria-selected={selected}
                            key={code}
                            className={`rf-search-result ${selected ? 'selected' : ''}`}
                            onClick={() => toggleCountry(code)}
                          >
                            <span>{name}</span>
                            <span className="rf-country-result-meta">
                              {selected && <Check size={13} aria-hidden="true" />}
                              <span className="rf-country-code">{code}</span>
                            </span>
                          </button>
                        );
                      })}
                    </motion.div>
                  )}
                  {countrySearch && searchResults.length === 0 && (
                    <motion.p
                      key="empty"
                      className="rf-search-empty"
                      initial={reduced ? false : { opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                    >
                      {isEnglish ? 'No matching countries' : 'No hay países coincidentes'}
                    </motion.p>
                  )}
                </AnimatePresence>

                {!countrySearch && (
                  <div className="rf-quick-countries">
                    <span className="rf-quick-label">{isEnglish ? 'Quick selection' : 'Selección rápida'}</span>
                    {/* Independent chips, not a group: each is its own ui Toggle
                        (`aria-pressed` from Base UI), and the stylesheet keys
                        the pressed look off `data-pressed`. */}
                    <div className="rf-quick-list">
                      {QUICK_COUNTRIES.map(code => (
                        <Toggle
                          key={code}
                          variant="outline"
                          className="rf-quick-country"
                          pressed={activeCountries.includes(code)}
                          onPressedChange={() => toggleCountry(code)}
                        >
                          {getCountryName(code, language)}
                        </Toggle>
                      ))}
                    </div>
                  </div>
                )}

                <motion.div
                  className="rf-map-wrap"
                  initial={reduced ? false : { opacity: 0, scale: 0.99 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.25, ease: EASE }}
                >
                  <WorldMap selectedCountries={activeCountries} onToggleCountry={toggleCountry} />
                  <p className="rf-map-hint">
                    {isEnglish ? 'Select a supported country on the map.' : 'Selecciona un país disponible en el mapa.'}
                  </p>
                </motion.div>

                <div className="rf-selected-countries" aria-live="polite">
                  <AnimatePresence>
                    {activeCountries.map(code => (
                      <motion.span
                        key={code}
                        className="rf-country-pill"
                        initial={reduced ? false : { opacity: 0, scale: 0.9, y: 3 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.9, y: 3 }}
                        transition={{ duration: 0.18 }}
                      >
                        {getCountryName(code, language)}
                        <button
                          type="button"
                          onClick={() => toggleCountry(code)}
                          aria-label={`${isEnglish ? 'Remove' : 'Quitar'} ${getCountryName(code, language)}`}
                        >
                          <X size={11} />
                        </button>
                      </motion.span>
                    ))}
                  </AnimatePresence>
                </div>
              </div>
            </Collapse>
          </Collapsible.Root>

          <div className="rf-actions">
            <Button
              type="button"
              variant="ghost"
              className="pl-0"
              onClick={() => setDraftFilters({ categories: [], countries: [] })}
              disabled={draftCount === 0}
            >
              <X size={13} /> {isEnglish ? 'Clear selection' : 'Limpiar selección'}
            </Button>
            <div className="rf-actions-primary">
              <Button type="button" variant="ghost" onClick={closePanel}>
                {isEnglish ? 'Cancel' : 'Cancelar'}
              </Button>
              <Button
                type="button"
                onClick={applyFilters}
                disabled={!hasPendingChanges || loading}
              >
                {loading ? <LoaderCircle className="rf-loading-icon" size={15} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}
                {isEnglish ? 'Apply filters' : 'Aplicar filtros'}
              </Button>
            </div>
          </div>
        </div>
      </Collapse>
    </Collapsible.Root>
  );
}
