// This module is also loaded by the Node build configuration; describe only
// the browser surface used by the serialized function.
interface StartupElement extends EventTarget {
  textContent: string | null;
  tagName: string;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  hasChildNodes(): boolean;
  remove(): void;
}
declare const document: { getElementById(id: string): StartupElement | null };
declare const window: EventTarget & {
  location: { reload(): void };
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(id: number): void;
};
declare const MutationObserver: new (callback: () => void) => {
  observe(target: StartupElement, options: { childList: boolean }): void;
  disconnect(): void;
};

// Serialized into index.html by Vite. Keep this function self-contained: it
// must run before, and independently of, the application's module graph.
export function installStartupGuard() {
  const panel = document.getElementById('startup-status');
  const root = document.getElementById('root');
  const title = document.getElementById('startup-title');
  const message = document.getElementById('startup-message');
  const retry = document.getElementById('startup-retry');
  if (!panel || !root || !title || !message || !retry) return;

  let finished = false;
  let failed = false;
  panel.setAttribute('data-state', 'pending');
  title.textContent = 'Loading PaperTok';
  message.textContent = 'Your page will appear here shortly.';

  // Fast mounts should not flash a recovery screen before the app's own loader.
  const loadingTimer = window.setTimeout(() => {
    if (!finished && !failed) panel.setAttribute('data-state', 'loading');
  }, 500);

  const showFailure = () => {
    if (finished) return;
    failed = true;
    window.clearTimeout(loadingTimer);
    panel.setAttribute('data-state', 'failed');
    title.textContent = 'PaperTok could not start';
    message.textContent = 'Reload the page to try again. If it still does not load, try another connection.';
  };

  const onError = (event: Event) => {
    const target = event.target as StartupElement | null;
    // Vite marks the initial app graph. Later optional imports and analytics
    // scripts must not turn their own blocked requests into a startup failure.
    if (event.target === window || (target && target.getAttribute('data-startup') === 'essential')) {
      showFailure();
    }
  };

  const reload = (event: Event) => {
    event.preventDefault();
    window.location.reload();
  };

  const timer = window.setTimeout(function () {
    if (finished || failed) return;
    panel.setAttribute('data-state', 'slow');
    title.textContent = 'PaperTok is taking longer than expected';
    message.textContent = 'You can keep waiting or reload the page to try again.';
  }, 15000);

  const observer = new MutationObserver(function () {
    if (!root.hasChildNodes()) return;
    finished = true;
    window.clearTimeout(loadingTimer);
    window.clearTimeout(timer);
    window.removeEventListener('error', onError, true);
    window.removeEventListener('unhandledrejection', showFailure);
    retry.removeEventListener('click', reload);
    observer.disconnect();
    panel.remove();
  });
  observer.observe(root, { childList: true });
  window.addEventListener('error', onError, true);
  window.addEventListener('unhandledrejection', showFailure);
  retry.addEventListener('click', reload);
}
