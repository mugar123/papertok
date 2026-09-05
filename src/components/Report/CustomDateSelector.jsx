import { useState, useEffect } from 'react';
import { Collapsible } from '@base-ui/react/collapsible';
import { ChevronRight, ChevronLeft, X } from 'lucide-react';
import { Button } from '../ui/button.jsx';
import { Slider } from '../ui/slider.jsx';
import { useLanguage } from '../../context/LanguageContext';
import {
  formatYMD,
  getDaysArray,
  monthWindowStart,
  monthsInWindow,
  prettyDate as readDate,
  resolveCustomPeriod,
} from '../../utils/customPeriod.js';
import './CustomDateSelector.css';
import { Toggle } from '../ui/toggle.jsx';

const MONTHS = {
  es: ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
};
const WEEKDAYS = {
  es: ['L', 'M', 'X', 'J', 'V', 'S', 'D'],
  en: ['M', 'T', 'W', 'T', 'F', 'S', 'S'],
};

const MIN_YEAR = 1950;

function getInitialSelection(value, currentYear) {
  const valid = value?.type === 'custom'
    && /^\d{4}-\d{2}-\d{2}$/.test(value.from || '')
    && /^\d{4}-\d{2}-\d{2}$/.test(value.to || '');
  if (!valid) {
    return { yearRange: [Math.max(MIN_YEAR, currentYear - 10), currentYear], start: null, end: null, month: 0 };
  }

  return {
    yearRange: [Number(value.from.slice(0, 4)), Number(value.to.slice(0, 4))],
    start: value.from,
    end: value.to,
    month: Math.max(0, Math.min(11, Number(value.from.slice(5, 7)) - 1)),
  };
}

/**
 * Where a year sits along the rail, and which way its label has to lean so it
 * does not hang off the end. Centred everywhere except the last few percent at
 * either side, where it anchors instead.
 */
function railPosition(year, currentYear) {
  const span = Math.max(1, currentYear - MIN_YEAR);
  const percent = Math.max(0, Math.min(100, ((year - MIN_YEAR) / span) * 100));
  const shift = percent < 7 ? '0' : percent > 93 ? '-100%' : '-50%';
  return { left: `${percent}%`, transform: `translateX(${shift})` };
}

export default function CustomDateSelector({ value, onApply, onCancel }) {
  const { language, isEnglish } = useLanguage();
  const currentYear = new Date().getFullYear();
  const initial = getInitialSelection(value, currentYear);
  const today = new Date();
  const todayStr = formatYMD(today.getFullYear(), today.getMonth(), today.getDate());

  const [yearRange, setYearRange] = useState(initial.yearRange);
  const isSingleYear = yearRange[0] === yearRange[1];

  const [showCalendar, setShowCalendar] = useState(isSingleYear && Boolean(initial.start));
  const [monthWindow, setMonthWindow] = useState(monthWindowStart(initial.month));
  const [startDateStr, setStartDateStr] = useState(initial.start);
  const [endDateStr, setEndDateStr] = useState(initial.end);

  /* Escape closes the day step rather than the whole panel: the panel has its
     own close, and losing a range because the calendar was open is a bad trade.
     There is no click-outside handler — step two is a Collapsible that expands
     in place, not a popover, so clicking elsewhere on the page has no business
     collapsing it. */
  useEffect(() => {
    if (!showCalendar) return undefined;
    const handleKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setShowCalendar(false);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [showCalendar]);

  /* The ui Slider reports the pair as an array; Base UI keeps the two thumbs
     from crossing, and they may meet (one year), which is what unlocks step
     two. */
  const handleYearRangeChange = (nextRange) => {
    setYearRange(nextRange);
    setShowCalendar(false);
    setStartDateStr(null);
    setEndDateStr(null);
    /* Back to the top of the year as well. Leaving the calendar parked on
       whichever quarter was last open meant a fresh year could open on, say,
       April — with nothing on screen saying the year had changed under it. */
    setMonthWindow(0);
  };

  /* Worked out in one place — `utils/customPeriod.js` — so the sentence on
     screen and the period that gets applied cannot drift apart, and so the
     month arithmetic can be pinned by tests. */
  const period = resolveCustomPeriod({ yearRange, startDateStr, endDateStr, todayStr });

  const handleApply = () => {
    onApply({ type: 'custom', from: period.from, to: period.to });
  };

  /* Every day helper takes the month it belongs to now that three are on
     screen at once; none of them may read a "current month" from state. */
  const handleDayClick = (month, day) => {
    if (!day) return;
    const clickedDateStr = formatYMD(yearRange[0], month, day);
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

  const isDaySelected = (month, day) => {
    if (!day) return false;
    const cellDateStr = formatYMD(yearRange[0], month, day);
    if (startDateStr === cellDateStr) return true;
    if (endDateStr === cellDateStr) return true;
    if (startDateStr && endDateStr && cellDateStr > startDateStr && cellDateStr < endDateStr) return true;
    return false;
  };

  const isDayEndpoint = (month, day) => {
    if (!day) return false;
    const cellDateStr = formatYMD(yearRange[0], month, day);
    return cellDateStr === startDateStr || cellDateStr === endDateStr;
  };

  const locale = language === 'en' ? 'en-US' : 'es-ES';
  const prettyDate = (iso) => readDate(iso, locale);
  const visibleMonths = monthsInWindow(monthWindow);

  const spanYears = yearRange[1] - yearRange[0] + 1;
  const stepTwoReady = isSingleYear;

  // Decade marks along the rail, plus the two real ends of the scale.
  const ticks = [];
  for (let year = MIN_YEAR; year <= currentYear; year += 1) {
    if (year === MIN_YEAR || year === currentYear || year % 20 === 0) ticks.push(year);
  }

  return (
    <div className="cds">
      <div className="cds-head cds-enter" style={{ '--enter-order': 0 }}>
        <span className="cds-title">{isEnglish ? 'Custom period' : 'Periodo personalizado'}</span>
        <span className="cds-hint">
          {isEnglish ? 'Two steps: the years, then the days' : 'Dos pasos: los años y luego los días'}
        </span>
        <button
          type="button"
          className="cds-close"
          onClick={onCancel}
          aria-label={isEnglish ? 'Close date selector' : 'Cerrar selector de fechas'}
        >
          <X size={16} />
        </button>
      </div>

      <div className="cds-rail-wrap cds-enter" style={{ '--enter-order': 1 }}>
        <div className="cds-rail-labels" aria-hidden="true">
          <span className="cds-rail-label" style={railPosition(yearRange[0], currentYear)}>{yearRange[0]}</span>
          {!isSingleYear && (
            <span className="cds-rail-label" style={railPosition(yearRange[1], currentYear)}>{yearRange[1]}</span>
          )}
        </div>
        <div className="cds-rail">
          <Slider
            min={MIN_YEAR}
            max={currentYear}
            value={yearRange}
            onValueChange={handleYearRangeChange}
            getAriaLabel={(index) => (isEnglish ? ['Start year', 'End year'] : ['Año inicial', 'Año final'])[index]}
          />
        </div>
        <div className="cds-rail-ticks" aria-hidden="true">
          {ticks.map(year => (
            <span key={year} className="cds-tick" style={railPosition(year, currentYear)}>{year}</span>
          ))}
        </div>
      </div>

      <div className="cds-steps cds-enter" style={{ '--enter-order': 2 }}>
        <div className="cds-step">
          <span className="cds-step-n">1</span>
          <span className="cds-step-body">
            {isEnglish ? 'Drag the two ends to the years you want.' : 'Arrastra los dos extremos a los años que quieras.'}
          </span>
          <span className="cds-step-why">
            {isSingleYear
              ? `${yearRange[0]}`
              : `${yearRange[0]} — ${yearRange[1]}`}
            {' · '}
            {isEnglish
              ? `${spanYears} ${spanYears === 1 ? 'year' : 'years'}`
              : `${spanYears} ${spanYears === 1 ? 'año' : 'años'}`}
          </span>
        </div>

        {/* Step two is always here, greyed with its reason rather than absent.
            A control that vanishes teaches nothing about why it vanished. */}
        {stepTwoReady ? (
          // Step two is a Base UI Collapsible, not a popover: the calendar is
          // three months wide and belongs in the flow of the panel, under the
          // row that opens it. Base UI writes `aria-expanded`, `aria-controls`
          // and `data-panel-open` on the trigger and folds the panel on a CSS
          // transition, waiting for the exit before unmounting.
          <Collapsible.Root
            className="cds-step-two"
            open={showCalendar}
            onOpenChange={(open) => setShowCalendar(open)}
          >
            <Collapsible.Trigger render={<button type="button" className="cds-step cds-step--action" />}>
              <span className="cds-step-n">2</span>
              <span className="cds-step-body">
                {isEnglish ? 'Narrow to exact days.' : 'Afina a días exactos.'}
              </span>
              <span className="cds-step-why">
                {startDateStr
                  ? (isEnglish ? 'Days chosen' : 'Días elegidos')
                  : (isEnglish ? 'Optional' : 'Opcional')}
                <ChevronRight size={14} className="cds-step-chevron" aria-hidden="true" />
              </span>
            </Collapsible.Trigger>

            <Collapsible.Panel className="cds-cal-slot">
              <div className="cds-cal">
                <div className="cds-cal-head">
                  <button
                    type="button"
                    className="cds-cal-nav"
                    onClick={() => setMonthWindow(w => Math.max(0, w - 3))}
                    disabled={monthWindow === 0}
                    aria-label={isEnglish ? 'Earlier months' : 'Meses anteriores'}
                  >
                    <ChevronLeft size={16} />
                  </button>
                  <span className="cds-cal-month">{yearRange[0]}</span>
                  <button
                    type="button"
                    className="cds-cal-nav"
                    onClick={() => setMonthWindow(w => Math.min(9, w + 3))}
                    disabled={monthWindow >= 9}
                    aria-label={isEnglish ? 'Later months' : 'Meses siguientes'}
                  >
                    <ChevronRight size={16} />
                  </button>
                </div>

                {/* Three months at a time. Step two is confined to one year, so
                    a quarter fits the width the panel actually has and a range
                    that crosses a month no longer needs paging to set. */}
                <div className="cds-cal-months">
                  {visibleMonths.map(month => (
                    <div className="cds-cal-month-block" key={month}>
                      <span className="cds-cal-month-name">{MONTHS[language][month]}</span>
                      <div className="cds-cal-grid">
                        {WEEKDAYS[language].map((wd, index) => (
                          <span key={`${month}-${wd}-${index}`} className="cds-cal-wd">{wd}</span>
                        ))}
                        {getDaysArray(yearRange[0], month).map((day, idx) => {
                          if (!day) {
                            return <span key={`empty-${month}-${idx}`} className="cds-cal-day is-blank" aria-hidden="true" />;
                          }
                          const dateValue = formatYMD(yearRange[0], month, day);
                          const isFuture = dateValue > todayStr;
                          return (
                            <Toggle
                              key={dateValue}
                              className={`cds-cal-day ${isDaySelected(month, day) ? 'is-in-range' : ''} ${isDayEndpoint(month, day) ? 'is-end' : ''}`}
                              onClick={() => handleDayClick(month, day)}
                              disabled={isFuture}
                              aria-label={prettyDate(dateValue)}
                              pressed={isDaySelected(month, day)}
                            >
                              {day}
                            </Toggle>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>

                {startDateStr && (
                  <button
                    type="button"
                    className="cds-cal-clear"
                    onClick={() => { setStartDateStr(null); setEndDateStr(null); }}
                  >
                    {isEnglish ? 'Clear the days' : 'Quitar los días'}
                  </button>
                )}
              </div>
            </Collapsible.Panel>
          </Collapsible.Root>
        ) : (
          <div className="cds-step cds-step--off">
            <span className="cds-step-n">2</span>
            <span className="cds-step-body">
              {isEnglish ? 'Narrow to exact days.' : 'Afina a días exactos.'}
            </span>
            <span className="cds-step-why">
              {isEnglish
                ? 'Available once both ends sit on the same year'
                : 'Disponible cuando los dos extremos caen en el mismo año'}
            </span>
          </div>
        )}
      </div>

      {/* The sentence is the readout and the validation at once: it says what
          Apply is about to ask for, in the words the period is written in. */}
      <div className="cds-reading cds-enter" style={{ '--enter-order': 3 }}>
        <p className="cds-reading-line">
          {isEnglish
            ? `Papers published between ${prettyDate(period.from)} and ${prettyDate(period.to)}.`
            : `Papers publicados entre el ${prettyDate(period.from)} y el ${prettyDate(period.to)}.`}
        </p>
        <span className="cds-reading-note">
          {period.from} → {period.to}
          {period.cappedAtToday && ` · ${isEnglish ? 'closed at today' : 'cerrado en hoy'}`}
        </span>
        <div className="cds-reading-actions">
          <Button type="button" variant="outline" onClick={onCancel}>
            {isEnglish ? 'Cancel' : 'Cancelar'}
          </Button>
          <Button type="button" onClick={handleApply}>
            {isEnglish ? 'Apply period' : 'Aplicar periodo'}
          </Button>
        </div>
      </div>
    </div>
  );
}
