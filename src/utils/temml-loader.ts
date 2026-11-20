type Temml = typeof import('temml').default;

declare global {
  interface Window { temml?: Temml }
}

let temmlModule: Temml | null = null;
let temmlPromise: Promise<Temml | null> | null = null;

/** The loaded library, or null while it is still on its way. */
export function getTemml() {
  return temmlModule;
}

export function loadTemml() {
  temmlPromise ??= Promise.all([
    import('temml/dist/temml.min.js?url').then(({ default: url }) => new Promise<Temml>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = url;
      script.onload = () => (window.temml ? resolve(window.temml) : reject(new Error('Temml did not define itself')));
      script.onerror = reject;
      document.head.append(script);
    })),
    import('temml/dist/Temml-Local.css').catch(() => null),
  ])
    .then(([module]) => (temmlModule = module))
    .catch(() => {
      temmlPromise = null;
      return null;
    });
  return temmlPromise;
}

/** A formula's MathML, or null when it links to or names an equation, which the source's own MathML resolves. */
export function temmlMarkup(temml: Temml, tex: string, display: boolean) {
  const html = temml.renderToString(tex, { displayMode: display, throwOnError: true, strict: false, trust: false });
  return /class="tml-ref| id="/.test(html) ? null : html;
}
