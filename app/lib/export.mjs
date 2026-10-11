const REDACTED = '[redacted]';
const normalizedKey = (key) =>
  String(key)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
const privateKey = (key) =>
  /token|secret|password|passwd|credential|csrf|session|authorization|cookie|proxykey|apikey/.test(
    normalizedKey(key)
  ) || ['auth', 'bearer', 'jwt', 'privatekey', 'signingkey'].includes(normalizedKey(key));
const privateParameter = (key) =>
  privateKey(key) || ['key', 'sig', 'signature', 'code'].includes(normalizedKey(key));

function redactText(value, sessionIds) {
  let text = value;
  for (const id of sessionIds) if (id) text = text.replaceAll(id, REDACTED);
  text = text
    .replace(/\bbh_[a-z0-9._~-]+/gi, REDACTED)
    .replace(/\bBearer\s+[a-z0-9._~+\/-]+=*/gi, 'Bearer ' + REDACTED);
  text = text.replace(/https?:\/\/[^\s<>"`]+/gi, (match) => {
    try {
      const url = new URL(match);
      if (url.username || url.password) {
        url.username = '';
        url.password = '';
      }
      for (const key of [...url.searchParams.keys()]) {
        if (privateParameter(key)) url.searchParams.delete(key);
        else {
          const values = url.searchParams.getAll(key);
          if (values.some((value) => /\bbh_/i.test(value) || /Bearer\s/i.test(value))) {
            url.searchParams.delete(key);
            for (const value of values)
              url.searchParams.append(
                key,
                value
                  .replace(/\bbh_[a-z0-9._~-]+/gi, REDACTED)
                  .replace(/\bBearer\s+\S+/gi, 'Bearer ' + REDACTED)
              );
          }
        }
      }
      // Some applications put credentials in a fragment rather than the query.
      if (
        url.hash &&
        /(?:token|secret|password|session|csrf|auth|bh_)/i.test(decodeURIComponent(url.hash))
      )
        url.hash = '';
      const decodedPath = decodeURIComponent(url.pathname);
      if (/\bbh_/i.test(decodedPath))
        url.pathname = decodedPath.replace(/\bbh_[a-z0-9._~-]+/gi, REDACTED);
      return url.href;
    } catch {
      return '[redacted URL]';
    }
  });
  // Guard accidental configuration pasted into a note or an upstream error.
  return text.replace(
    /\b((?:CRM_TOKEN|PROXY_KEY|CRON_SECRET|SITES_SERVICE_TOKEN|api[_-]?key|csrf[_-]?token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
    '$1' + REDACTED
  );
}

export function sanitize(value, sessionIds = []) {
  if (typeof value === 'string') return redactText(value, sessionIds);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, sessionIds));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !privateKey(key) &&
            !['html', 'rawhtml', 'requestheaders', 'responseheaders'].includes(normalizedKey(key))
        )
        .map(([key, item]) => [redactText(key, sessionIds), sanitize(item, sessionIds)])
    );
  return value;
}

/** Read-only, portable audit bundle. The server supplies values to redact. */
export async function exportEvidence(db, mode, credentialValues = []) {
  const all = async (sql) => (await db.prepare(sql).bind().all()).results;
  const proposals = await all('SELECT * FROM proposals ORDER BY created,id');
  const decisions = await all('SELECT * FROM decisions ORDER BY created,id');
  const operations = await all('SELECT * FROM operations ORDER BY proposal_id,step,id');
  const runs = await all('SELECT * FROM runs ORDER BY started,id');
  const audits = await all('SELECT * FROM audits ORDER BY created,id');
  const decodeRows = (rows) => rows.map(({ data, ...row }) => ({ ...row, data: JSON.parse(data) }));
  const decodedAudits = decodeRows(audits);
  const privateValues = [
    ...new Set(
      [
        ...credentialValues,
        ...decisions.map((row) => row.session_id),
        ...decodedAudits.map((row) => row.data?.session),
      ].filter((value) => typeof value === 'string' && value)
    ),
  ];
  return sanitize(
    {
      contract_version: 1,
      exported_at: new Date().toISOString(),
      mode,
      proposals: decodeRows(proposals),
      decisions: decisions.map(({ id, proposal_id, action, option_id, actor, note, created }) => ({
        id,
        proposal_id,
        action,
        option_id,
        actor,
        note,
        created,
      })),
      operations: decodeRows(operations),
      runs: runs.map(({ id, status, started, finished, data }) => {
        const saved = JSON.parse(data),
          snapshot = saved.snapshot;
        return {
          id,
          status,
          started,
          finished,
          counts: saved.counts ?? null,
          coverage: snapshot?.coverage ?? null,
          source_index: (snapshot?.pages ?? []).map(({ url, retrieved_at_utc, hash }) => ({
            url,
            retrieved_at_utc,
            hash,
          })),
          snapshot: snapshot
            ? {
                retrieved_at: snapshot.retrieved_at ?? null,
                accounts: snapshot.accounts,
                contacts: snapshot.contacts,
                facilities: snapshot.facilities,
              }
            : null,
          error: saved.error ?? null,
        };
      }),
      audits: decodedAudits,
    },
    privateValues
  );
}
