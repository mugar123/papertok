// `mugar123.github.io` sigue en la lista: GitHub Pages redirige el sitio viejo
// al dominio nuevo, pero un service worker ya instalado alli puede servir el
// bundle cacheado una vez mas antes de ver la redireccion. El 18-09-2026 se
// retiro el workflow que publicaba ahi, y el sitio se deja en pie justo por
// esa redireccion; esta entrada se quita cuando se decida que ya no queda
// nadie con ese worker instalado, que es una decision con fecha y no un
// olvido. Mientras siga aqui, cualquier pagina publicada en ese origen puede
// llamar a esta API: no publiques nada mas en el.
const DEFAULT_ALLOWED_ORIGINS = [
  'https://papertok.app',
  'https://www.papertok.app',
  'https://mugar123.github.io',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'permissions-policy': 'camera=(), microphone=(), geolocation=()',
      ...headers,
    },
  });
}

export function allowedOrigins(env) {
  return new Set([
    ...DEFAULT_ALLOWED_ORIGINS,
    ...String(env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean),
  ]);
}

export function corsHeaders(origin, env) {
  return allowedOrigins(env).has(origin)
    ? { 'access-control-allow-origin': origin, vary: 'Origin' }
    : {};
}
