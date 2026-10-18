import { useState, useEffect, useRef } from 'react';
import { CaretDown, CaretLeft, Check } from '@phosphor-icons/react';
import { useAuth } from '../../context/AuthContext.tsx';
import useIsPhone from '../../hooks/useIsPhone.ts';
import { CATEGORIES } from '../../data/categories.ts';
import { USER_PREFERENCES_MAX } from '../../utils/accountOnboarding.ts';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog.tsx';
import { Drawer, DrawerContent, DrawerHandle, DrawerTitle } from '../ui/drawer.tsx';
import { Button } from '../ui/button.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs.tsx';
import { Toggle } from '../ui/toggle.tsx';
import './EditInterestsModal.css';

/**
 * SettingsPage keeps this mounted and drives it through `isOpen`, so the
 * Dialog is controlled from outside: the X, Escape and the scrim report
 * `onOpenChange(false)`, which is the parent's `onClose`, and Base UI plays
 * the leave before the popup goes. The primitive also owns what this
 * overlay never had — a dialog role, `aria-modal`, the focus trap.
 *
 * On a phone the same editor is a bottom Drawer, and the fields are one
 * switcher, as on the phone Settings page: the field you are in, and the list
 * of every field to move to. The list replaces the topics inside the same
 * sheet rather than opening a second drawer over the first.
 */
export default function EditInterestsModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { userPreferences, updatePreferences } = useAuth();
  const [selected, setSelected] = useState(new Set<string>());
  const [isSaving, setIsSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [activeArea, setActiveArea] = useState(Object.keys(CATEGORIES)[0]);
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const switcherRef = useRef<HTMLButtonElement | null>(null);
  const backRef = useRef<HTMLButtonElement | null>(null);
  const pickedField = useRef(false);
  const isPhone = useIsPhone();

  // Initialize selection when modal opens
  useEffect(() => {
    if (isOpen && userPreferences) {
      const timeoutId = setTimeout(() => {
        setSelected(new Set(userPreferences));
        setFormError('');
        const firstFollowed = Object.keys(CATEGORIES).find(areaKey => (
          Object.keys(CATEGORIES[areaKey].subcategories).some(subKey => userPreferences.includes(subKey))
        ));
        setActiveArea(firstFollowed || Object.keys(CATEGORIES)[0]);
        setFieldsOpen(false);
      }, 0);
      return () => clearTimeout(timeoutId);
    }
    return undefined;
  }, [isOpen, userPreferences]);

  const toggleSubcategory = (subKey: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(subKey)) {
        next.delete(subKey);
      } else {
        next.add(subKey);
      }
      return next;
    });
  };

  const toggleArea = (areaKey: string) => {
    const subKeys = Object.keys(CATEGORIES[areaKey].subcategories);
    const allSelected = subKeys.every(k => selected.has(k));
    
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        subKeys.forEach(k => next.delete(k));
      } else {
        subKeys.forEach(k => next.add(k));
      }
      return next;
    });
  };

  const handleSave = async () => {
    if (selected.size === 0) {
      // A clear immediately followed by the same-tick set is not enough:
      // React 18+ batches both calls from one click into a single commit, and
      // when the resulting text matches what was already committed (a repeat
      // click with nothing selected), react-dom's own prop diff skips the DOM
      // write ('next === last' short-circuits before touching textContent) —
      // confirmed by reading react-dom-client's updateProperties and by a
      // jsdom repro with a MutationObserver: same-tick clear+set produced no
      // mutation and no re-announcement on the second click.
      // The failure branch below does not have this problem only because the
      // `await` separates its clear from its set into two distinct commits —
      // the element actually unmounts (formError is '', falsy) and remounts
      // fresh, which is a real, always-observable mutation. `setTimeout(0)`
      // recreates that same separation here, on the same tick-deferral this
      // file already uses elsewhere (see the init effect).
      setFormError('');
      setTimeout(() => {
        setFormError('Select at least one research area.');
      }, 0);
      return;
    }
    if (selected.size > USER_PREFERENCES_MAX) {
      // Same tick-deferral as the empty case above, for the same reason: a
      // repeat click must re-announce the error, not be swallowed by the diff.
      setFormError('');
      setTimeout(() => {
        setFormError(`At most ${USER_PREFERENCES_MAX} interests: drop ${selected.size - USER_PREFERENCES_MAX}.`);
      }, 0);
      return;
    }
    setFormError('');
    setIsSaving(true);
    try {
      await updatePreferences(Array.from(selected));
      onClose();
    } catch (error) {
      console.error('Error saving preferences:', error);
      setFormError('We could not save your changes. Try again.');
    } finally {
      setIsSaving(false);
    }
  };

  useEffect(() => {
    if (fieldsOpen) backRef.current?.focus();
    else if (pickedField.current) switcherRef.current?.focus();
    pickedField.current = false;
  }, [fieldsOpen]);

  const leaveFields = () => {
    pickedField.current = true;
    setFieldsOpen(false);
  };

  const counted = (areaKey: string) => Object.keys(CATEGORIES[areaKey].subcategories).filter(k => selected.has(k)).length;

  /** One field's topics, with its count and its Select all. */
  const fieldTopics = (areaKey: string) => {
    const area = CATEGORIES[areaKey];
    const subKeys = Object.keys(area.subcategories);
    const count = counted(areaKey);
    const allSelected = count === subKeys.length;
    return (
      <>
        <div className="eim-area-header">
          <div>
            <h3 className="eim-area-title">{area.label}</h3>
            <p className="eim-area-count">
              {count ? `${count} of ${subKeys.length} selected` : `${subKeys.length} topics`}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => toggleArea(areaKey)}>
            {allSelected ? 'Deselect all' : 'Select all'}
          </Button>
        </div>
        <div className="eim-subcats">
          {Object.entries(area.subcategories).map(([subKey, sub]) => {
            const isSelected = selected.has(subKey);
            return (
              <Toggle
                key={subKey}
                variant="outline"
                className="eim-pill"
                pressed={isSelected}
                onPressedChange={() => toggleSubcategory(subKey)}
              >
                {sub.label}
              </Toggle>
            );
          })}
        </div>
      </>
    );
  };

  const errorAndFooter = (
    <>
    {formError && (
      <p className="eim-form-error" role="alert">{formError}</p>
    )}

    <div className="eim-footer">
      <span className="eim-selected-count">
        {`${selected.size} selected ${selected.size === 1 ? 'interest' : 'interests'}`}
      </span>
      <Button
        size="lg"
        onClick={handleSave}
        disabled={isSaving}
        aria-busy={isSaving ? 'true' : undefined}
      >
        {isSaving && <div className="eim-spinner" aria-hidden="true" />}
        {isSaving ? ('Saving...') : ('Save changes')}
      </Button>
    </div>
    </>
  );

  if (isPhone) {
    const area = CATEGORIES[activeArea];
    return (
      <Drawer open={isOpen} onOpenChange={nextOpen => { if (!nextOpen) onClose(); }}>
        <DrawerContent className="eim-sheet">
          <DrawerHandle />
          {fieldsOpen ? (
            <>
              <div className="eim-fields-head">
                <Button ref={backRef} variant="ghost" size="icon-sm" aria-label={'Back to topics'} onClick={leaveFields}>
                  <CaretLeft size={18} aria-hidden="true" />
                </Button>
                <DrawerTitle render={<h2 />}>{'Research fields'}</DrawerTitle>
              </div>
              <ul className="eim-fields-list" data-base-ui-swipe-ignore="">
                {Object.entries(CATEGORIES).map(([areaKey, entry]) => {
                  const picked = counted(areaKey);
                  const isActive = areaKey === activeArea;
                  return (
                    <li key={areaKey}>
                      <button
                        type="button"
                        className={isActive ? 'is-active' : undefined}
                        aria-current={isActive ? 'true' : undefined}
                        onClick={() => { setActiveArea(areaKey); leaveFields(); }}
                      >
                        <entry.icon size={20} weight={isActive ? 'fill' : 'regular'} aria-hidden="true" />
                        <span className="eim-fields-copy">
                          <strong>{entry.label}</strong>
                          <small>
                            {picked
                              ? `${picked} of ${Object.keys(entry.subcategories).length} selected`
                              : `${Object.keys(entry.subcategories).length} topics`}
                          </small>
                        </span>
                        {isActive && <Check size={16} aria-hidden="true" />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : (
            <>
              <div className="eim-sheet-head">
                <DrawerTitle render={<h2 />}>{'Configure your algorithm'}</DrawerTitle>
                <p>{'Select the research areas you want to see in your feed'}</p>
                <button
                  ref={switcherRef}
                  type="button"
                  className="eim-switcher"
                  aria-expanded={false}
                  onClick={() => setFieldsOpen(true)}
                >
                  <span className="eim-switcher-icon"><area.icon size={18} weight="fill" aria-hidden="true" /></span>
                  <span className="eim-switcher-copy">
                    <small>{'Field'}</small>
                    <strong>{area.label}</strong>
                  </span>
                  <CaretDown size={16} aria-hidden="true" />
                </button>
              </div>
              <div className="eim-area eim-sheet-body" data-base-ui-swipe-ignore="">
                {fieldTopics(activeArea)}
              </div>
              {errorAndFooter}
            </>
          )}
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={isOpen} onOpenChange={nextOpen => { if (!nextOpen) onClose(); }} modal>
      <DialogContent
        className="eim-modal"
        overlayClassName="eim-overlay"
        closeLabel={'Close'}
      >
        <div className="eim-header">
          <div className="eim-header-text">
            <DialogTitle>{'Configure your algorithm'}</DialogTitle>
            <DialogDescription>{'Select the research areas you want to see in your feed'}</DialogDescription>
          </div>
        </div>

        <div className="eim-body">
          {/* One field at a time: the fields down a rail, the chosen field's
              topics beside it. */}
          <Tabs value={activeArea} onValueChange={value => setActiveArea(value as string)} orientation="vertical" className="eim-rail">
            <TabsList variant="pill" className="eim-rail-list" aria-label={'Research fields'}>
              {Object.entries(CATEGORIES).map(([areaKey, area]) => (
                <TabsTrigger key={areaKey} value={areaKey} className="eim-rail-tab">
                  <area.icon size={18} aria-hidden="true" />
                  <span className="eim-rail-label">{area.label}</span>
                </TabsTrigger>
              ))}
            </TabsList>
            {Object.keys(CATEGORIES).map(areaKey => (
              <TabsContent key={areaKey} value={areaKey} className="eim-area">
                {fieldTopics(areaKey)}
              </TabsContent>
            ))}
          </Tabs>
        </div>

        {errorAndFooter}
      </DialogContent>
    </Dialog>
  );
}
