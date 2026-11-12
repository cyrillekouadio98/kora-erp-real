/**
 * Configuration de production : aucun secret de développement accepté, prestataire de paiement de test absent.
 * Ces tests ne touchent pas la base : ils rechargent les modules avec un environnement simulé.
 */
const PROD_ENV = {
  NODE_ENV: 'production',
  WEB_URL: 'https://app.kora.example',
  DATABASE_OWNER_URL: 'postgres://kora_owner:s3cret-owner@db:5432/kora',
  DATABASE_APP_URL: 'postgres://kora_app:s3cret-app@db:5432/kora',
  DATABASE_PLATFORM_URL: 'postgres://kora_platform:s3cret-platform@db:5432/kora',
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  PAYMENT_SANDBOX_SECRET: 'sandbox-secret-dev',
};

function load<T>(env: Record<string, string | undefined>, modulePath: string): T {
  const saved = { ...process.env };
  try {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    let mod: T | undefined;
    jest.isolateModules(() => { mod = require(modulePath); });
    return mod!;
  } finally {
    process.env = saved;
  }
}

const loadConfig = (env: Record<string, string | undefined>) => load<typeof import('../src/config')>(env, '../src/config').config;

describe('Configuration de production', () => {
  it('démarre avec des secrets propres à l’environnement', () => {
    const config = loadConfig(PROD_ENV);
    expect(config.isProd).toBe(true);
    expect(config.payments.sandboxSecret).toBeNull();
  });

  it.each([
    ['ENCRYPTION_KEY', undefined, /manquante/],
    ['ENCRYPTION_KEY', 'ZGV2LW9ubHktMzItYnl0ZXMta2V5LWNoYW5nZS1tZSE=', /valeur de développement/],
    ['ENCRYPTION_KEY', 'dHJvcC1jb3VydGU=', /32 octets/],
    ['WEB_URL', undefined, /manquante/],
    ['DATABASE_APP_URL', undefined, /manquante/],
    ['DATABASE_APP_URL', 'postgres://kora_app:kora_app_dev@localhost:5432/kora', /valeur de développement/],
    ['DATABASE_OWNER_URL', 'postgres://kora_owner:kora_owner_dev@db.prod:5432/kora', /mot de passe de développement/],
  ])('refuse de démarrer si %s vaut %s', (name, value, error) => {
    expect(() => loadConfig({ ...PROD_ENV, [name]: value })).toThrow(error);
  });

  it("n'expose pas le prestataire de test, même si son secret est défini", () => {
    const { PAYMENT_PROVIDERS, SandboxProvider } = load<typeof import('../src/modules/billing/payment-provider')>(PROD_ENV, '../src/modules/billing/payment-provider');
    expect(PAYMENT_PROVIDERS.sandbox).toBeUndefined();
    expect(Object.keys(PAYMENT_PROVIDERS)).toHaveLength(0);
    expect(() => SandboxProvider.sign('{}')).toThrow(/désactivé/);
  });

  it('lit le nombre de proxys de confiance, et refuse de faire confiance à tous', () => {
    expect(loadConfig({ NODE_ENV: 'test', TRUST_PROXY: undefined }).trustProxy).toBe(1);
    expect(loadConfig({ NODE_ENV: 'test', TRUST_PROXY: '2' }).trustProxy).toBe(2);
    expect(loadConfig({ NODE_ENV: 'test', TRUST_PROXY: 'loopback, 10.0.0.0/8' }).trustProxy).toBe('loopback, 10.0.0.0/8');
    expect(() => loadConfig({ NODE_ENV: 'test', TRUST_PROXY: 'true' })).toThrow(/n'importe quel/);
  });

  it('garde le prestataire de test hors production', () => {
    const { PAYMENT_PROVIDERS } = load<typeof import('../src/modules/billing/payment-provider')>({ NODE_ENV: 'test' }, '../src/modules/billing/payment-provider');
    expect(PAYMENT_PROVIDERS.sandbox).toBeDefined();
  });
});
