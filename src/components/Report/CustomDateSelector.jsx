import { useState, useEffect } from 'react';
import Slider from 'rc-slider';
import 'rc-slider/assets/index.css';
import { ChevronRight, Calendar as CalendarIcon, Check, ChevronLeft } from 'lucide-react';
import './CustomDateSelector.css';

const MONTHS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const WEEKDAYS = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];

export default function CustomDateSelector({ onApply, onCancel }) {
  const currentYear = new Date().getFullYear();
  const MIN_YEAR = 1950;
  
  // Phase 1: Year Range
  const [yearRange, setYearRange] = useState([1994, 2008]);
  
  // Phase 2: Exact Date Mode
  const isSingleYear = yearRange[0] === yearRange[1];
  const [exactDateMode, setExactDateMode] = useState(false);
  const [selectedMonth, setSelectedMonth] = useState(0); // 0-11
  
  // Start and End dates for ranges within the single year. 
  const [startDay, setStartDay] = useState(null);
  const [endDay, setEndDay] = useState(null);

  // Reset calendar state when years change
  useEffect(() => {
    if (!isSingleYear) {
      setExactDateMode(false);
    }
  }, [isSingleYear, yearRange]);

  const handleApply = () => {
    if (isSingleYear && exactDateMode && startDay) {
      const y = yearRange[0];
      const m = String(selectedMonth + 1).padStart(2, '0');
      
      const sD = String(startDay).padStart(2, '0');
      const eD = String(endDay || startDay).padStart(2, '0');
      
      onApply({ 
        type: 'custom', 
        from: `${y}-${m}-${sD}`, 
        to: `${y}-${m}-${eD}` 
      });
    } else {
      onApply({ 
        type: 'custom', 
        from: `${yearRange[0]}-01-01`, 
        to: `${yearRange[1]}-12-31` 
      });
    }
  };

  const getDaysArray = (year, month) => {
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const firstDayIndex = new Date(year, month, 1).getDay(); // 0 = Sunday
    const startOffset = firstDayIndex === 0 ? 6 : firstDayIndex - 1; // Adjust for Monday start
    
    const blanks = Array.from({ length: startOffset }, () => null);
    const days = Array.from({ length: daysInMonth }, (_, i) => i + 1);
    
    return [...blanks, ...days];
  };

  const handleDayClick = (day) => {
    if (!day) return;
    
    if (startDay && endDay) {
      setStartDay(day);
      setEndDay(null);
    } else if (startDay && !endDay) {
      if (day < startDay) {
        setEndDay(startDay);
        setStartDay(day);
      } else {
        setEndDay(day);
      }
    } else {
      setStartDay(day);
      setEndDay(null);
    }
  };

  const isDaySelected = (day) => {
    if (!day) return false;
    if (startDay === day) return true;
    if (endDay === day) return true;
    if (startDay && endDay && day > startDay && day < endDay) return true;
    return false;
  };

  const isDayEndpoint = (day) => {
    if (!day) return false;
    return day === startDay || day === endDay;
  };

  const daysArray = getDaysArray(yearRange[0], selectedMonth);

  return (
    <div className="cds-container glass-strong">
      <div className="cds-header">
        <h3>Filtro Histórico</h3>
        <button className="cds-close-btn" onClick={onCancel}>✕</button>
      </div>

      <div className="cds-body">
        {/* YEAR RANGE SLIDER */}
        <div className="cds-section">
          <div className="cds-labels-row">
            <span className="cds-label-title">Periodo de Tiempo</span>
            <span className="cds-label-value">{yearRange[0]} — {yearRange[1]}</span>
          </div>
          
          <div className="cds-slider-wrapper">
            <Slider
              range
              min={MIN_YEAR}
              max={currentYear}
              value={yearRange}
              onChange={(val) => setYearRange(val)}
              trackStyle={[{ backgroundColor: 'var(--accent)', height: 6 }]}
              handleStyle={[
                { backgroundColor: '#fff', borderColor: 'var(--accent)', width: 22, height: 22, marginTop: -8, boxShadow: '0 2px 10px rgba(0,0,0,0.3)', opacity: 1 },
                { backgroundColor: '#fff', borderColor: 'var(--accent)', width: 22, height: 22, marginTop: -8, boxShadow: '0 2px 10px rgba(0,0,0,0.3)', opacity: 1 }
              ]}
              railStyle={{ backgroundColor: 'rgba(255, 255, 255, 0.1)', height: 6 }}
            />
          </div>

          {isSingleYear && !exactDateMode && (
            <div className="cds-single-year-hint" onClick={() => setExactDateMode(true)}>
              <CalendarIcon size={14} />
              <span>Seleccionar día o rango exacto en {yearRange[0]}</span>
              <ChevronRight size={14} />
            </div>
          )}
        </div>

        {/* EXACT DATE MODE (CALENDAR) */}
        {isSingleYear && exactDateMode && (
          <div className="cds-calendar-section slide-in">
            <div className="cds-calendar-header">
              <button 
                className="cds-cal-nav" 
                onClick={() => setSelectedMonth(m => Math.max(0, m - 1))}
                disabled={selectedMonth === 0}
              >
                <ChevronLeft size={16} />
              </button>
              <div className="cds-cal-title">
                {MONTHS[selectedMonth]} {yearRange[0]}
              </div>
              <button 
                className="cds-cal-nav" 
                onClick={() => setSelectedMonth(m => Math.min(11, m + 1))}
                disabled={selectedMonth === 11}
              >
                <ChevronRight size={16} />
              </button>
            </div>

            <div className="cds-calendar-grid">
              {WEEKDAYS.map(wd => (
                <div key={wd} className="cds-cal-weekday">{wd}</div>
              ))}
              {daysArray.map((day, idx) => (
                <div 
                  key={idx} 
                  className={`cds-cal-day ${day ? 'active' : 'empty'} ${isDaySelected(day) ? 'selected' : ''} ${isDayEndpoint(day) ? 'endpoint' : ''}`}
                  onClick={() => handleDayClick(day)}
                >
                  {day}
                </div>
              ))}
            </div>

            <div className="cds-exact-summary">
              {startDay ? (
                <>Día{endDay ? 's' : ''}: <strong>{startDay} {endDay ? `al ${endDay}` : ''} de {MONTHS[selectedMonth]}</strong></>
              ) : (
                <span className="cds-summary-placeholder">Selecciona un día en el calendario</span>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="cds-footer">
        <button className="cds-apply-btn" onClick={handleApply}>
          <Check size={16} /> Generar Edición Histórica
        </button>
      </div>
    </div>
  );
}
