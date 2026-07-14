import { useState, useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { CATEGORIES } from '../../data/categories';
import { COUNTRIES, searchCountries } from '../../data/countries';
import { Filter, Search, X, MapPin, ChevronDown, ChevronUp } from 'lucide-react';
import WorldMap from './WorldMap';
import './ReportFilters.css';

export default function ReportFilters({ filters, onChange }) {
  const [isOpen, setIsOpen] = useState(false);
  const [countrySearch, setCountrySearch] = useState('');

  const areaKeys = Object.keys(CATEGORIES);
  
  const searchResults = useMemo(() => {
    return searchCountries(countrySearch);
  }, [countrySearch]);

  const toggleCategory = (key) => {
    const current = filters.categories || [];
    const next = current.includes(key)
      ? current.filter(k => k !== key)
      : [...current, key];
    onChange({ ...filters, categories: next });
  };

  const toggleCountry = (code) => {
    const current = filters.countries || [];
    const next = current.includes(code)
      ? current.filter(c => c !== code)
      : [...current, code];
    onChange({ ...filters, countries: next });
    setCountrySearch('');
  };

  const clearAll = () => {
    onChange({ categories: [], countries: [] });
  };

  const activeCount = (filters.categories?.length || 0) + (filters.countries?.length || 0);

  return (
    <div className="rf">
      {/* Toggle button */}
      <button className="rf-toggle" onClick={() => setIsOpen(!isOpen)}>
        <div className="rf-toggle-left">
          <Filter size={14} />
          <span>Filtros</span>
          {activeCount > 0 && <span className="rf-badge">{activeCount}</span>}
        </div>
        {isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>

      {/* Expandable panel */}
      {isOpen && (
        <div className="rf-panel">
          {/* Category filters */}
          <div className="rf-section">
            <span className="rf-section-label">Disciplina</span>
            <div className="rf-pills">
              {areaKeys.map(key => {
                const area = CATEGORIES[key];
                const Icon = area.icon;
                const isActive = (filters.categories || []).includes(key);
                return (
                  <button
                    key={key}
                    className={`rf-pill ${isActive ? 'active' : ''}`}
                    onClick={() => toggleCategory(key)}
                    style={isActive ? { background: area.gradient, borderColor: 'transparent' } : {}}
                  >
                    <Icon size={13} />
                    {area.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Country filters */}
          <div className="rf-section">
            <span className="rf-section-label"><MapPin size={13} /> País de origen</span>
            
            {/* Search */}
            <div className="rf-search-wrap">
              <Search size={14} className="rf-search-icon" />
              <input
                className="rf-search"
                type="text"
                placeholder="Buscar país..."
                value={countrySearch}
                onChange={(e) => setCountrySearch(e.target.value)}
              />
              {countrySearch && (
                <button className="rf-search-clear" onClick={() => setCountrySearch('')}>
                  <X size={12} />
                </button>
              )}
            </div>
            
            {/* Search results dropdown */}
            {searchResults.length > 0 && (
              <div className="rf-search-results">
                {searchResults.map(({ code, name }) => (
                  <button
                    key={code}
                    className={`rf-search-result ${(filters.countries || []).includes(code) ? 'selected' : ''}`}
                    onClick={() => toggleCountry(code)}
                  >
                    <span>{name}</span>
                    <span className="rf-country-code">{code}</span>
                  </button>
                ))}
              </div>
            )}
            
            {/* World Map */}
            <WorldMap
              selectedCountries={filters.countries || []}
              onToggleCountry={toggleCountry}
            />
            
            {/* Selected countries pills */}
            <div className="rf-selected-countries">
              <AnimatePresence>
                {(filters.countries || []).map(code => (
                  <motion.span 
                    key={code} 
                    className="rf-country-pill"
                    initial={{ opacity: 0, scale: 0.8, y: 5 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.8, y: 5 }}
                    transition={{ duration: 0.2 }}
                  >
                    {COUNTRIES[code] || code}
                    <button onClick={() => toggleCountry(code)}><X size={10} /></button>
                  </motion.span>
                ))}
              </AnimatePresence>
            </div>
          </div>

          {/* Clear all */}
          {activeCount > 0 && (
            <button className="rf-clear" onClick={clearAll}>
              <X size={12} /> Limpiar filtros
            </button>
          )}
        </div>
      )}
    </div>
  );
}
