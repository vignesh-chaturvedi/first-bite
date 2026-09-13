const DATABASE_URL_ERROR = 'A valid PostgreSQL DATABASE_URL is required';

/** Validate without echoing an input that may contain credentials. */
export function parseDatabaseUrl(value: string | undefined): URL {
  try {
    if (!value) throw new Error();
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)
      || !url.hostname || !url.pathname.slice(1) || url.hash) throw new Error();
    // pg accepts query-string connection overrides. Do not allow the apparent
    // hostname/database in the URL to differ from the actual connection.
    for (const key of ['host', 'hostaddr', 'port', 'user', 'password', 'dbname', 'database', 'service', 'passfile']) {
      if (url.searchParams.has(key)) throw new Error();
    }
    return url;
  } catch {
    throw new Error(DATABASE_URL_ERROR);
  }
}

export function assertLocalFixtureUrl(value: string, nodeEnv?: string): void {
  const url = parseDatabaseUrl(value);
  if (nodeEnv === 'production'
    || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || !/^first_bite_(dev|test)$/.test(url.pathname.slice(1))
    || url.searchParams.has('options')) {
    throw new Error('Fixtures require a local first_bite_dev or first_bite_test database outside production');
  }
}
