const WIKIDATA_TMDB_MOVIE_PROP = 'wdt:P4947';
const WIKIDATA_TMDB_TV_PROP = 'wdt:P4983';
const WIKIDATA_IMDB_PROP = 'wdt:P345';

function normalizeTmdbIdForWikidata(tmdbId) {
  const normalized = String(tmdbId ?? '').trim();
  return /^\d+$/.test(normalized) ? normalized : null;
}

function buildTmdbToImdbWikidataQuery(tmdbId) {
  const normalizedTmdbId = normalizeTmdbIdForWikidata(tmdbId);
  if (!normalizedTmdbId) {
    return null;
  }

  return `
    SELECT ?imdb WHERE {
      { ?item ${WIKIDATA_TMDB_MOVIE_PROP} "${normalizedTmdbId}". }
      UNION
      { ?item ${WIKIDATA_TMDB_TV_PROP} "${normalizedTmdbId}". }
      ?item ${WIKIDATA_IMDB_PROP} ?imdb.
    } LIMIT 1
  `.trim().replace(/\s+/g, ' ');
}

module.exports = {
  WIKIDATA_TMDB_MOVIE_PROP,
  WIKIDATA_TMDB_TV_PROP,
  WIKIDATA_IMDB_PROP,
  normalizeTmdbIdForWikidata,
  buildTmdbToImdbWikidataQuery
};
