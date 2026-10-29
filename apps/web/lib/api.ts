/** Client HTTP de l'interface : toutes les requêtes passent par /api (proxy Next.js vers l'API). */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    credentials: 'same-origin',
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const isJson = res.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await res.json() : null;
  if (!res.ok) {
    const e = data?.error ?? {};
    throw new ApiError(res.status, e.code ?? 'error', e.message ?? 'Une erreur est survenue.', e.details);
  }
  return data as T;
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const details = Array.isArray(e.details) ? e.details.map((d: any) => d.message).filter(Boolean).join(' · ') : '';
    return details ? `${e.message} ${details}` : e.message;
  }
  return 'Connexion impossible avec le serveur. Vérifiez votre réseau.';
}
