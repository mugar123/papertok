import { useState, useEffect, useRef } from 'react';
import Slider from 'rc-slider';
import 'rc-slider/assets/index.css';
import { ChevronRight, Calendar as CalendarIcon, Check, ChevronLeft, ChevronDown } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import './CustomDateSelector.css';

const MONTHS = {
  es: ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
};
const WEEKDAYS = {
  es: ['L', 'M', 'X', 'J', 'V', 'S', 'D'],
  en: ['M', 'T', 'W', 'T', 'F', 'S', 'S'],
};

function formatYMD(year, month, day) {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function getInitialSelection(value, currentYear) {
  const valid = value?.type === 'custom'
    && /^\d{4}-\d{2}-\d{2}$/.test(value.from || '')
    && /^\d{4}-\d{2}-\d{2}$/.test(value.to || '');
  if (!valid) {
    return { yearRange: [Math.max(1950, currentYear - 10), currentYear], start: null, end: null, month: 0 };
  }

  return {
    yearRange: [Number(value.from.slice(0, 4)), Number(value.to.slice(0, 4))],
    start: value.from,
    end: value.to,
    month: Math.max(0, Math.min(11, Number(value.from.slice(5, 7)) - 1)),
  };
}

export default function CustomDateSelector({ value, onApply, onCancel }) {
  const { language, isEnglish } = useLanguage();
  const currentYear = new Date().getFullYear();
  const MIN_YEAR = 1950;
  const initial = getInitialSelection(value, currentYear);
  const today = new Date();
  const todayStr = formatYMD(today.getFullYear(), today.getMonth(), today.getDate());

  const [yearRange, setYearRange] = useState(initial.yearRange);
  const isSingleYear = yearRange[0] === yearRange[1];

  const [exactDateMode, setExactDateMode] = useState(isSingleYear && Boolean(initial.start));
  const [selectedMonth, setSelectedMonth] = useState(initial.month);
  const [startDateStr, setStartDateStr] = useState(initial.start);
  const [endDateStr, setEndDateStr] = useState(initial.end);

  const selectorRef = useRef(null);

  // Close popover when clicking outside
  useEffect(() => {
    function handleClickOutside(event) {
      if (selectorRef.current && !selectorRef.current.contains(event.target)) {
        setExactDateMode(false);
      }
    }
    function handleKeyDown(event) {
      if (event.key === 'Escape') setExactDateMode(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  const handleYearRangeChange = (nextRange) => {
    setYearRange(nextRange);
    setExactDateMode(false);
    setStartDateStr(null);
    setEndDateStr(null);
  };

  const handleApply = () => {
    if (startDateStr) {
      onApply({ type: 'custom', from: startDateStr, to: endDateStr || startDateStr });
    } else {
      const fullRangeEnd = `${yearRange[1]}-12-31`;
      onApply({
        type: 'custom',
        from: `${yearRange[0]}-01-01`,
        to: fullRangeEnd > todayStr ? todayStr : fullRangeEnd,
      });
    }
  };

  const getDaysArray = (year, month) => {
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const firstDayIndex = new Date(year, month, 1).getDay(); 
    const startOffset = firstDayIndex === 0 ? 6 : firstDayIndex - 1; 
    
    const blanks = Array.from({ length: startOffset }, () => null);
    const days = Array.from({ length: daysInMonth }, (_, i) => i + 1);
    
    return [...blanks, ...days];
  };

  const handleDayClick = (day) => {
    if (!day) return;
    const clickedDateStr = formatYMD(yearRange[0], selectedMonth, day);
    if (clickedDateStr > todayStr) return;
    
    if (startDateStr && endDateStr) {
      setStartDateStr(clickedDateStr);
      setEndDateStr(null);
    } else if (startDateStr && !endDateStr) {
      if (clickedDateStr < startDateStr) {
        setEndDateStr(startDateStr);
        setStartDateStr(clickedDateStr);
      } else {
        setEndDateStr(clickedDateStr);
      }
    } else {
      setStartDateStr(clickedDateStr);
      setEndDateStr(null);
    }
  };

  const isDaySelected = (day) => {
    if (!day) return false;
    const cellDateStr = formatYMD(yearRange[0], selectedMonth, day);
    if (startDateStr === cellDateStr) return true;
    if (endDateStr === cellDateStr) return true;
    if (startDateStr && endDateStr && cellDateStr > startDateStr && cellDateStr < endDateStr) return true;
    return false;
  };

  const isDayEndpoint = (day) => {
    if (!day) return false;
    const cellDateStr = formatYMD(yearRange[0], selectedMonth, day);
    return cellDateStr === startDateStr || cellDateStr === endDateStr;
  };

  const daysArray = getDaysArray(yearRange[0], selectedMonth);
  const formatDayLabel = (day) => new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'es-ES', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(yearRange[0], selectedMonth, day));

  return (
    <div className="cds-minimal-container" ref={selectorRef}>
      <div className="cds-minimal-header">
        <span className="cds-minimal-title">{isEnglish ? 'Historical period' : 'Periodo histórico'}</span>
        <button
          type="button"
          className="cds-minimal-close"
          onClick={onCancel}
          aria-label={isEnglish ? 'Close date selector' : 'Cerrar selector de fechas'}
        >✕</button>
      </div>

      <div className="cds-minimal-timeline">
        <div className="cds-timeline-labels">
          <span className="cds-year-label">{yearRange[0]}</span>
          <span className="cds-year-divider">—</span>
          <span className="cds-year-label">{yearRange[1]}</span>
        </div>

        <div className="cds-timeline-slider">
          <Slider
            range
            min={MIN_YEAR}
            max={currentYear}
            value={yearRange}
            onChange={handleYearRangeChange}
            ariaLabelForHandle={isEnglish ? ['Start year', 'End year'] : ['Año inicial', 'Año final']}
            trackStyle={[{ background: 'linear-gradient(90deg, #9b87f5, #7E69AB)', height: 4 }]}
            handleStyle={[
              { backgroundColor: '#fff', borderColor: 'transparent', width: 16, height: 16, marginTop: -6, boxShadow: '0 0 10px rgba(155, 135, 245, 0.5)' },
              { backgroundColor: '#fff', borderColor: 'transparent', width: 16, height: 16, marginTop: -6, boxShadow: '0 0 10px rgba(155, 135, 245, 0.5)' }
            ]}
            railStyle={{ backgroundColor: 'rgba(255, 255, 255, 0.1)', height: 4 }}
          />
        </div>
      </div>

      <div className="cds-minimal-actions">
        {isSingleYear ? (
          <div className="cds-popover-wrapper">
            <button 
              type="button"
              className={`cds-badge-btn ${exactDateMode ? 'active' : ''}`}
              onClick={() => setExactDateMode(!exactDateMode)}
              aria-expanded={exactDateMode}
            >
              <CalendarIcon size={14} />
              <span>{startDateStr
                ? `${isEnglish ? 'Selection' : 'Selección'}: ${startDateStr}`
                : `${isEnglish ? 'Daily precision in' : 'Precisión diaria en'} ${yearRange[0]}`}</span>
              <ChevronDown size={14} className={`cds-badge-arrow ${exactDateMode ? 'rotated' : ''}`} />
            </button>

            {exactDateMode && (
              <div className="cds-floating-calendar">
                <div className="cds-fcal-header">
                  <button
                    type="button"
                    className="cds-fcal-nav"
                    onClick={() => setSelectedMonth(m => Math.max(0, m - 1))}
                    disabled={selectedMonth === 0}
                    aria-label={isEnglish ? 'Previous month' : 'Mes anterior'}
                  >
                    <ChevronLeft size={16} />
                  </button>
                  <span className="cds-fcal-month">{MONTHS[language][selectedMonth]} {yearRange[0]}</span>
                  <button
                    type="button"
                    className="cds-fcal-nav"
                    onClick={() => setSelectedMonth(m => Math.min(11, m + 1))}
                    disabled={selectedMonth === 11}
                    aria-label={isEnglish ? 'Next month' : 'Mes siguiente'}
                  >
                    <ChevronRight size={16} />
                  </button>
                </div>
                
                <div className="cds-fcal-grid">
                  {WEEKDAYS[language].map((wd, index) => <div key={`${wd}-${index}`} className="cds-fcal-wd">{wd}</div>)}
                  {daysArray.map((day, idx) => {
                    if (!day) return <span key={`empty-${idx}`} className="cds-fcal-day empty" aria-hidden="true" />;
                    const dateValue = formatYMD(yearRange[0], selectedMonth, day);
                    const isFuture = dateValue > todayStr;
                    return (
                      <button
                        type="button"
                        key={dateValue}
                        className={`cds-fcal-day ${isDaySelected(day) ? 'selected' : ''} ${isDayEndpoint(day) ? 'endpoint' : ''}`}
                        onClick={() => handleDayClick(day)}
                        disabled={isFuture}
                        aria-label={formatDayLabel(day)}
                        aria-pressed={isDaySelected(day)}
                      >
                        {day}
                      </button>
                    );
                  })}
                </div>
                
                <div className="cds-exact-summary" style={{ marginTop: 16, fontSize: 13, color: 'rgba(255,255,255,0.7)', textAlign: 'center' }}>
                  {startDateStr ? (
                    <>
                      {isEnglish ? 'From' : 'Desde'}: <strong>{startDateStr}</strong>
                      {endDateStr ? <><br/>{isEnglish ? 'To' : 'Hasta'}: <strong>{endDateStr}</strong></> : ''}
                    </>
                  ) : (
                    <span className="cds-summary-placeholder">
                      {isEnglish ? 'Select the boundary dates' : 'Selecciona los días límite'}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="cds-badge-placeholder">{isEnglish ? 'General historical range' : 'Rango histórico general'}</div>
        )}

        <button type="button" className="cds-minimal-apply" onClick={handleApply}>
          <Check size={16} /> {isEnglish ? 'Search' : 'Buscar'}
        </button>
      </div>
    </div>
  );
}
