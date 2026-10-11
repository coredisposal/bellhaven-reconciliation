'use client';
import { useState } from 'react';
import { ArrowUpRight, Search } from 'lucide-react';
import type { WebsiteSnapshot, Run } from '../lib/ui-types';
import './locations.css';

function stamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Capture time unavailable'
    : `${date.toLocaleString('en-US', {
        timeZone: 'UTC',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })} UTC`;
}

function sourceHref(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? value : undefined;
  } catch {
    return undefined;
  }
}

export default function Locations({
  snapshot,
  latestRun,
  onReview,
}: {
  snapshot?: WebsiteSnapshot | null;
  latestRun?: Run;
  onReview: (sourceUrl: string) => void;
}) {
  const [query, setQuery] = useState('');
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const facilities = snapshot?.facilities ?? [];
  const filtered = facilities.filter((facility) => {
    const text = [
      facility.name,
      facility.street_address,
      facility.city,
      facility.state,
      facility.postal_code,
      ...facility.care_offerings,
    ]
      .join(' ')
      .toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
  const coverage = latestRun?.data.coverage;
  const incomplete =
    coverage && typeof coverage === 'object' && 'complete' in coverage
      ? coverage.complete === false
      : false;
  const refreshProblem = latestRun?.status === 'failed' || incomplete;
  const refreshing = latestRun?.status === 'running';

  return (
    <section className="document locations" aria-labelledby="locations-heading">
      <div className="section-heading">
        <h2 id="locations-heading">Website locations</h2>
      </div>
      <p className="locations-status" role="status">
        {snapshot ? (
          <>
            <strong>{facilities.length} locations</strong>
            {' · '}
            {snapshot.coverage.complete ? 'Complete collection' : 'Incomplete collection'}
            {snapshot.coverage.expected !== null
              ? ` (${snapshot.coverage.found} of ${snapshot.coverage.expected})`
              : ''}
            {' · '}
            <time dateTime={snapshot.collected_at}>{stamp(snapshot.collected_at)}</time>
          </>
        ) : (
          'No website collection saved yet.'
        )}
        {refreshing ? ' Refresh in progress.' : ''}
      </p>
      {refreshProblem && (
        <p className="locations-warning" role="status">
          {latestRun?.status === 'failed'
            ? 'The latest refresh failed.'
            : 'The latest refresh was incomplete.'}{' '}
          {snapshot
            ? 'Showing the last saved collection. Refresh sources to try again.'
            : 'Refresh sources to collect the website locations.'}
        </p>
      )}
      {facilities.length > 0 ? (
        <>
          <div className="locations-tools">
            <label className="locations-search" htmlFor="location-search">
              <span>Search locations</span>
              <span className="locations-search-field">
                <Search size={17} aria-hidden="true" />
                <input
                  id="location-search"
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Name, address, state, ZIP, or care"
                  aria-controls="locations-table"
                />
              </span>
            </label>
            <span className="locations-result-count" role="status">
              {filtered.length} of {facilities.length} shown
            </span>
          </div>
          {filtered.length ? (
            <table className="locations-table" id="locations-table" role="table">
              <caption className="locations-sr-only">
                Locations and original evidence from the saved website collection
              </caption>
              <thead role="rowgroup">
                <tr role="row">
                  <th scope="col" role="columnheader">
                    Location & source
                  </th>
                  <th scope="col" role="columnheader">
                    Address
                  </th>
                  <th scope="col" role="columnheader">
                    Care offerings
                  </th>
                  <th scope="col" role="columnheader">
                    <span className="locations-sr-only">Review</span>
                  </th>
                </tr>
              </thead>
              <tbody role="rowgroup">
                {filtered.map((facility) => {
                  const href = sourceHref(facility.source_url);
                  return (
                    <tr key={facility.source_url} role="row">
                      <th scope="row" role="rowheader" className="locations-name">
                        <strong>{facility.name}</strong>
                        <span className="locations-source">
                          {href ? (
                            <a
                              href={href}
                              target="_blank"
                              rel="noopener noreferrer"
                              aria-label={`View source for ${facility.name} (opens in a new tab)`}
                            >
                              Source <ArrowUpRight size={13} aria-hidden="true" />
                            </a>
                          ) : (
                            <span>Source unavailable</span>
                          )}
                          <time
                            dateTime={facility.retrieved_at_utc}
                            title={facility.retrieved_at_utc}
                          >
                            {stamp(facility.retrieved_at_utc)}
                          </time>
                        </span>
                      </th>
                      <td role="cell" className="locations-address">
                        <span>{facility.street_address}</span>
                        <span>
                          {facility.city}, {facility.state} {facility.postal_code}
                        </span>
                      </td>
                      <td role="cell" className="locations-care">
                        <ul aria-label="Care offerings">
                          {facility.care_offerings.map((offering, index) => (
                            <li key={`${offering}-${index}`}>{offering}</li>
                          ))}
                        </ul>
                      </td>
                      <td role="cell" className="locations-action">
                        <button
                          className="secondary"
                          onClick={() => onReview(facility.source_url)}
                          aria-label={`Review match for ${facility.name}`}
                        >
                          Review match
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <div className="locations-empty" id="locations-table">
              <h3>No locations match this search</h3>
              <p>Try a different name, address, or care offering.</p>
              <button className="secondary" onClick={() => {
                setQuery('');
                document.getElementById('location-search')?.focus();
              }}>
                Clear search
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="locations-empty">
          <h3>No website locations to display</h3>
          <p>Use Refresh sources to collect the latest directory and homepage locations.</p>
        </div>
      )}
    </section>
  );
}
