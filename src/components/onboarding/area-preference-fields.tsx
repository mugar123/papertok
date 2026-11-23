import {
  DEFAULT_INTEREST_MIX, INTEREST_MIXES, priorityForArea,
  type AreaPreference, type AreaPriority, type InterestMix, type InterestSettings,
} from '../../utils/area-preferences.ts';
import type { ReadingLevel } from '../../utils/user-settings.ts';
import './area-preference-fields.css';

type SettingsFieldProps = {
  settings: InterestSettings;
  onChange: (settings: InterestSettings) => void;
};

export function AreaPreferenceFields({ area, name, settings, onChange, showReadingLevel = false }: SettingsFieldProps & {
  area: string;
  name: string;
  showReadingLevel?: boolean;
}) {
  const preference = settings.areaPreferences?.[area];
  const change = (patch: AreaPreference) => onChange({
    ...settings,
    areaPreferences: { ...settings.areaPreferences, [area]: { ...preference, ...patch } },
  });
  return (
    <div className="area-preference-fields">
      <label className="area-preference-field">
        <span>Priority</span>
        <select
          aria-label={`Priority for ${name}`}
          value={priorityForArea(settings, area)}
          onChange={event => change({ priority: event.currentTarget.value as AreaPriority })}
        >
          <option value="essential">Essential</option>
          <option value="curiosity">Curiosity</option>
        </select>
      </label>
      {showReadingLevel && (
        <label className="area-preference-field">
          <span>Read in plain words</span>
          <select
            aria-label={`Read in plain words for ${name}`}
            value={preference?.level ?? ''}
            onChange={event => change({ level: (event.currentTarget.value || undefined) as ReadingLevel | undefined })}
          >
            <option value="">Use my default</option>
            <option value="beginner">Beginner</option>
            <option value="university">University</option>
            <option value="researcher">Researcher</option>
          </select>
        </label>
      )}
    </div>
  );
}

export function InterestMixField({ areas, settings, onChange }: SettingsFieldProps & { areas: Iterable<string> }) {
  const priorities = new Set(Array.from(areas, area => priorityForArea(settings, area)));
  if (priorities.size < 2) return null;
  return (
    <label className="area-preference-field">
      <span>Feed mix (Essential / Curiosity)</span>
      <select
        value={settings.interestMix ?? DEFAULT_INTEREST_MIX}
        onChange={event => onChange({ ...settings, interestMix: event.currentTarget.value as InterestMix })}
      >
        {Object.entries(INTEREST_MIXES).map(([id, { label, essential }]) => (
          <option key={id} value={id}>{`${label} (${essential}/${100 - essential})`}</option>
        ))}
      </select>
    </label>
  );
}
