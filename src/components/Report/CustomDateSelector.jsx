import { useState, useEffect, useRef } from 'react';
import Slider from 'rc-slider';
import 'rc-slider/assets/index.css';
import { ChevronRight, Calendar as CalendarIcon, Check, ChevronLeft, ChevronDown } from 'lucide-react';
import './CustomDateSelector.css';

const MONTHS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const WEEKDAYS = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];

export default function CustomDateSelector({ onApply, onCancel }) {
  const currentYear = new Date().getFullYear();
  const MIN_YEAR = 1950;
  
  const [yearRange, setYearRange] = useState([1994, 2008]);
  const isSingleYear = yearRange[0] === yearRange[1];
  
  const [exactDateMode, setExactDateMode] = useState(false);
  const [selectedMonth, setSelectedMonth] = useState(0); 
  
  // Start and End full date strings (YYYY-MM-DD)
  const [startDateStr, setStartDateStr] = useState(null);
  const [endDateStr, setEndDateStr] = useState(null);

  const formatYMD = (year, month, day) => {
    return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  };

  const popoverRef = useRef(null);

  // Close popover when clicking outside
  useEffect(() => {
    function handleClickOutside(event) {
      if (popoverRef.current && !popoverRef.current.contains(event.target)) {
        setExactDateMode(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [popoverRef]);

  const handleYearRangeChange = (nextRange) => {
    setYearRange(nextRange);
    if (nextRange[0] !== nextRange[1]) {
      setExactDateMode(false);
      setStartDateStr(null);
      setEndDateStr(null);
    }
  };

  const handleApply = () => {
    if (isSingleYear && exactDateMode && startDateStr) {
      onApply({ type: 'custom', from: startDateStr, to: endDateStr || startDateStr });
    } else {
      onApply({ type: 'custom', from: `${yearRange[0]}-01-01`, to: `${yearRange[1]}-12-31` });
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

  return (
    <div className="cds-minimal-container">
      <div className="cds-minimal-header">
        <span className="cds-minimal-title">Periodo Histórico</span>
        <button className="cds-minimal-close" onClick={onCancel}>✕</button>
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
          <div className="cds-popover-wrapper" ref={popoverRef}>
            <button 
              className={`cds-badge-btn ${exactDateMode ? 'active' : ''}`}
              onClick={() => setExactDateMode(!exactDateMode)}
            >
              <CalendarIcon size={14} />
              <span>{startDateStr ? `Selección: ${startDateStr}` : `Precisión diaria en ${yearRange[0]}`}</span>
              <ChevronDown size={14} className={`cds-badge-arrow ${exactDateMode ? 'rotated' : ''}`} />
            </button>

            {exactDateMode && (
              <div className="cds-floating-calendar">
                <div className="cds-fcal-header">
                  <button className="cds-fcal-nav" onClick={() => setSelectedMonth(m => Math.max(0, m - 1))} disabled={selectedMonth === 0}>
                    <ChevronLeft size={16} />
                  </button>
                  <span className="cds-fcal-month">{MONTHS[selectedMonth]} {yearRange[0]}</span>
                  <button className="cds-fcal-nav" onClick={() => setSelectedMonth(m => Math.min(11, m + 1))} disabled={selectedMonth === 11}>
                    <ChevronRight size={16} />
                  </button>
                </div>
                
                <div className="cds-fcal-grid">
                  {WEEKDAYS.map(wd => <div key={wd} className="cds-fcal-wd">{wd}</div>)}
                  {daysArray.map((day, idx) => (
                    <div 
                      key={idx} 
                      className={`cds-fcal-day ${!day ? 'empty' : ''} ${isDaySelected(day) ? 'selected' : ''} ${isDayEndpoint(day) ? 'endpoint' : ''}`}
                      onClick={() => handleDayClick(day)}
                    >
                      {day}
                    </div>
                  ))}
                </div>
                
                <div className="cds-exact-summary" style={{ marginTop: 16, fontSize: 13, color: 'rgba(255,255,255,0.7)', textAlign: 'center' }}>
                  {startDateStr ? (
                    <>Desde: <strong>{startDateStr}</strong> {endDateStr ? <><br/>Hasta: <strong>{endDateStr}</strong></> : ''}</>
                  ) : (
                    <span className="cds-summary-placeholder">Selecciona los días límite</span>
                  )}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="cds-badge-placeholder">Rango histórico general</div>
        )}

        <button className="cds-minimal-apply" onClick={handleApply}>
          <Check size={16} /> Buscar
        </button>
      </div>
    </div>
  );
}
