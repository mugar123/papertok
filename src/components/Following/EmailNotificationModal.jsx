import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Check, CheckCircle2, Clock3, Loader2, Mail, Send, X } from 'lucide-react';
import { useEmailNotifications } from '../../context/EmailNotificationsContext';
import { useLanguage } from '../../context/LanguageContext';
import { useDialogFocus } from '../../hooks/useDialogFocus.js';
import './EmailNotificationModal.css';

const ERROR_COPY = {
  es: {
    EMAIL_NOT_CONFIGURED: 'Los avisos por email todavía no están configurados.',
    EMAIL_AUTH_REQUIRED: 'Vuelve a iniciar sesión para configurar los avisos.',
    EMAIL_ADDRESS_NOT_VERIFIED: 'Confirma tu dirección de correo con tu proveedor de acceso antes de activar los avisos.',
    EMAIL_PROVIDER_AUTH_FAILED: 'El proveedor de correo ha rechazado la credencial configurada.',
    EMAIL_SENDER_NOT_VERIFIED: 'El remitente de Brevo todavía no está verificado.',
    EMAIL_PROVIDER_LIMIT: 'Se ha alcanzado temporalmente el límite de envío.',
    EMAIL_TEST_RATE_LIMIT: 'Espera un minuto antes de enviar otra prueba.',
    EMAIL_TEST_RECIPIENT_RESTRICTED: 'Resend está en modo de prueba y sólo permite enviar al correo propietario de la cuenta. Para otros destinatarios necesitas verificar un dominio.',
    EMAIL_DATA_LOADING: 'Estamos terminando de cargar tus seguimientos. Inténtalo de nuevo en unos segundos.',
    EMAIL_FOLLOWS_REQUIRED: 'Sigue al menos un tema, autor, institución o proyecto antes de activar los correos.',
    EMAIL_SEND_FAILED: 'No se ha podido enviar el correo de prueba.',
    EMAIL_TIMEOUT: 'El servicio de correo está tardando demasiado.',
    EMAIL_UNAVAILABLE: 'El servicio de correo no está disponible ahora mismo.',
  },
  en: {
    EMAIL_NOT_CONFIGURED: 'Email updates have not been configured yet.',
    EMAIL_AUTH_REQUIRED: 'Sign in again to configure email updates.',
    EMAIL_ADDRESS_NOT_VERIFIED: 'Confirm your email address with your sign-in provider before enabling email updates.',
    EMAIL_PROVIDER_AUTH_FAILED: 'The email provider rejected the configured credential.',
    EMAIL_SENDER_NOT_VERIFIED: 'The Brevo sender has not been verified yet.',
    EMAIL_PROVIDER_LIMIT: 'The sending limit has temporarily been reached.',
    EMAIL_TEST_RATE_LIMIT: 'Wait one minute before sending another test.',
    EMAIL_TEST_RECIPIENT_RESTRICTED: 'Resend is in test mode and can only send to the account owner. A verified domain is required for other recipients.',
    EMAIL_DATA_LOADING: 'We are still loading what you follow. Try again in a few seconds.',
    EMAIL_FOLLOWS_REQUIRED: 'Follow at least one topic, author, institution, or project before enabling emails.',
    EMAIL_SEND_FAILED: 'The test email could not be sent.',
    EMAIL_TIMEOUT: 'The email service is taking too long.',
    EMAIL_UNAVAILABLE: 'The email service is not available right now.',
  },
};

const MIN_TEST_SENDING_MS = 900;
const TEST_SENT_VISIBLE_MS = 5000;

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export default function EmailNotificationModal({ isOpen, onClose }) {
  const { language, isEnglish } = useLanguage();
  const prefersReducedMotion = useReducedMotion();
  const {
    preferences,
    health,
    loading,
    saving,
    testing,
    notificationDataReady,
    hasFollows,
    savePreferences,
    sendTest,
  } = useEmailNotifications();
  const [draft, setDraft] = useState(preferences);
  const [feedback, setFeedback] = useState(null);
  const [testState, setTestState] = useState('idle');
  const preferencesRef = useRef(preferences);
  const testFeedbackTimerRef = useRef(null);
  // Initial focus, a contained Tab cycle, Escape and focus return — the
  // shared dialog contract every overlay in the app now uses, instead of a
  // one-off Escape listener with no Tab containment at all.
  const dialogRef = useDialogFocus(isOpen, onClose);

  useEffect(() => {
    preferencesRef.current = preferences;
  }, [preferences]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const timeoutId = setTimeout(() => {
      setDraft(preferencesRef.current);
      setFeedback(null);
      setTestState('idle');
    }, 0);
    return () => {
      clearTimeout(timeoutId);
      clearTimeout(testFeedbackTimerRef.current);
    };
  }, [isOpen]);

  const handleSave = async () => {
    setFeedback(null);
    try {
      await savePreferences(draft);
      setFeedback({
        type: 'success',
        text: draft.enabled
          ? (isEnglish ? 'Email updates enabled.' : 'Avisos por email activados.')
          : (isEnglish ? 'Email updates disabled.' : 'Avisos por email desactivados.'),
      });
    } catch (error) {
      setFeedback({ type: 'error', text: ERROR_COPY[language][error.code] || ERROR_COPY[language].EMAIL_UNAVAILABLE });
    }
  };

  const handleTest = async () => {
    const startedAt = Date.now();
    setFeedback(null);
    setTestState('sending');
    clearTimeout(testFeedbackTimerRef.current);
    try {
      const result = await sendTest({ ...draft, enabled: true });
      const remainingSendingTime = MIN_TEST_SENDING_MS - (Date.now() - startedAt);
      if (remainingSendingTime > 0) await wait(remainingSendingTime);
      const saved = result.preferences;
      setDraft(saved);
      setFeedback({
        type: 'success',
        text: isEnglish ? `Test email sent to ${saved.email}.` : `Correo de prueba enviado a ${saved.email}.`,
      });
      setTestState('sent');
      testFeedbackTimerRef.current = setTimeout(() => setTestState('idle'), TEST_SENT_VISIBLE_MS);
    } catch (error) {
      setTestState('idle');
      setFeedback({ type: 'error', text: ERROR_COPY[language][error.code] || ERROR_COPY[language].EMAIL_UNAVAILABLE });
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="email-notification-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: prefersReducedMotion ? 0.1 : 0.2, ease: 'easeOut' }}
          onMouseDown={event => event.target === event.currentTarget && onClose()}
        >
          <motion.section
            ref={dialogRef}
            className="email-notification-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="email-notification-title"
            tabIndex={-1}
            initial={prefersReducedMotion ? false : { opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.98 }}
            transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
          >
            <header>
              <div className="email-notification-icon"><Mail size={20} /></div>
              <div>
                <h2 id="email-notification-title">{isEnglish ? 'Email updates' : 'Novedades por email'}</h2>
                <p>{isEnglish
                  ? 'Receive a compact digest even when PaperTok is closed.'
                  : 'Recibe un digest compacto aunque PaperTok esté cerrado.'}</p>
              </div>
              <button className="email-notification-close" data-dialog-initial-focus onClick={onClose} title={isEnglish ? 'Close' : 'Cerrar'}><X size={20} /></button>
            </header>

            <div className="email-notification-body">
              {!loading && !health.available && (
                <div className="email-notification-provider-warning">
                  <strong>{isEnglish ? 'Sending requires configuration' : 'Envío pendiente de configuración'}</strong>
                  <span>{health.code === 'EMAIL_PROVIDER_AUTH_FAILED'
                    ? (isEnglish ? 'The email provider did not accept the saved credential.' : 'El proveedor de correo no ha aceptado la credencial guardada.')
                    : health.code === 'EMAIL_SENDER_NOT_VERIFIED'
                      ? (isEnglish ? 'Brevo does not yet recognize the configured sender as active.' : 'Brevo todavía no reconoce el remitente configurado como activo.')
                      : (isEnglish ? 'The email provider is not available right now.' : 'El proveedor de correo no está disponible en este momento.')}</span>
                </div>
              )}
              {!loading && health.available && health.provider === 'resend' && health.senderMode === 'resend-test' && (
                <div className="email-notification-provider-warning is-info">
                  <strong>{isEnglish ? 'Resend test mode' : 'Modo de prueba de Resend'}</strong>
                  <span>{isEnglish
                    ? 'Without a verified domain, Resend will only deliver email to the account owner.'
                    : 'Sin un dominio verificado, Resend sólo entregará correos a la dirección propietaria de tu cuenta.'}</span>
                </div>
              )}
              {!loading && health.available && health.provider === 'resend' && health.permissionLimited && health.senderMode !== 'resend-test' && (
                <div className="email-notification-provider-warning is-info">
                  <strong>{isEnglish ? 'Restricted sending key' : 'Clave de envío restringida'}</strong>
                  <span>{isEnglish
                    ? 'The Resend credential only has sending permission, so the domain status cannot be checked here. Sending still works normally.'
                    : 'La credencial de Resend sólo tiene permiso de envío, así que no podemos comprobar el estado del dominio desde aquí. El envío funciona con normalidad.'}</span>
                </div>
              )}
              {!loading && notificationDataReady && !hasFollows && (
                <div className="email-notification-provider-warning is-info">
                  <strong>{isEnglish ? 'Nothing followed yet' : 'Todavía no sigues nada'}</strong>
                  <span>{isEnglish
                    ? 'Follow a topic, author, institution, or project so PaperTok can prepare relevant email updates.'
                    : 'Sigue un tema, autor, institución o proyecto para que PaperTok pueda preparar correos relevantes.'}</span>
                </div>
              )}
              <label className="email-notification-toggle-row">
                <span>
                  <strong>{isEnglish ? 'Enable email updates' : 'Activar correos'}</strong>
                  <small>{isEnglish ? 'They will be sent to' : 'Se enviarán a'} {draft.email || preferences.email}</small>
                </span>
                <input
                  type="checkbox"
                  checked={Boolean(draft.enabled)}
                  onChange={event => setDraft(current => ({ ...current, enabled: event.target.checked }))}
                  disabled={loading || (!health.available && !draft.enabled) || (!hasFollows && !draft.enabled)}
                />
                <span className="email-notification-switch" aria-hidden="true" />
              </label>

              <div className={`email-notification-options ${draft.enabled ? '' : 'is-disabled'}`}>
                <fieldset disabled={!draft.enabled || loading}>
                  <legend>{isEnglish ? 'Frequency' : 'Frecuencia'}</legend>
                  <div className="email-notification-segments">
                    <button className={draft.frequency === 'daily' ? 'is-active' : ''} onClick={() => setDraft(current => ({ ...current, frequency: 'daily' }))}>
                      {isEnglish ? 'Daily' : 'Diario'}
                    </button>
                    <button className={draft.frequency === 'weekly' ? 'is-active' : ''} onClick={() => setDraft(current => ({ ...current, frequency: 'weekly' }))}>
                      {isEnglish ? 'Weekly' : 'Semanal'}
                    </button>
                  </div>
                </fieldset>

                <label className="email-notification-count">
                  <span>
                    <strong>{isEnglish ? 'Maximum per email' : 'Máximo por correo'}</strong>
                    <small>{isEnglish
                      ? 'PaperTok will send fewer when there are not enough high-quality matches'
                      : 'PaperTok enviará menos si no encuentra suficiente calidad'}</small>
                  </span>
                  <select
                    value={draft.maxPapers || 5}
                    onChange={event => setDraft(current => ({ ...current, maxPapers: Number(event.target.value) }))}
                    disabled={!draft.enabled || loading}
                  >
                    <option value="3">3</option>
                    <option value="5">5</option>
                    <option value="10">10</option>
                  </select>
                </label>
              </div>

              <div className="email-notification-schedule">
                <Clock3 size={16} />
                <span>
                  {draft.frequency === 'weekly'
                    ? (isEnglish ? 'Monday mornings' : 'Los lunes por la mañana')
                    : (isEnglish ? 'Every morning' : 'Cada mañana')}, {isEnglish ? 'only when there are updates.' : 'sólo cuando haya novedades.'}
                </span>
              </div>

              {feedback && (
                <motion.p className={`email-notification-feedback is-${feedback.type}`} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}>
                  {feedback.type === 'success' && <Check size={15} />} {feedback.text}
                </motion.p>
              )}
            </div>

            <footer>
              <button
                className={`email-notification-test ${testState === 'sending' ? 'is-sending' : ''} ${testState === 'sent' ? 'is-sent' : ''}`}
                onClick={handleTest}
                disabled={saving || testing || loading || !notificationDataReady || !hasFollows || !health.available || testState === 'sent'}
                aria-live="polite"
                aria-busy={testState === 'sending'}
              >
                <AnimatePresence mode="wait" initial={false}>
                  {testState === 'sending' ? (
                    <motion.span key="sending" initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }}>
                      <Loader2 className="email-notification-test-spinner" size={16} /> {isEnglish ? 'Sending…' : 'Enviando…'}
                    </motion.span>
                  ) : testState === 'sent' ? (
                    <motion.span key="sent" initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}>
                      <CheckCircle2 size={17} /> {isEnglish ? 'Sent' : 'Enviado'}
                    </motion.span>
                  ) : (
                    <motion.span key="idle" initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }}>
                      <Send size={16} /> {isEnglish ? 'Send test' : 'Enviar prueba'}
                    </motion.span>
                  )}
                </AnimatePresence>
              </button>
              <button className="email-notification-save" onClick={handleSave} disabled={saving || testing || loading || !notificationDataReady || (draft.enabled && (!health.available || !hasFollows))}>
                {saving
                  ? (isEnglish ? 'Saving...' : 'Guardando...')
                  : (isEnglish ? 'Save changes' : 'Guardar cambios')}
              </button>
            </footer>
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
