import { openAlexJson } from './openAlexClient.js';
import { buildOpenAlexTrendFilter, normalizeReportFilters } from './openAlexReportQuery.js';
import { getComparisonPeriods, formatReportDate } from '../utils/scientificReportPeriods.js';
import { computeScientificTrends } from '../utils/reportTrendMath.js';

const TREND_CACHE = new Map();
const ACTIVE_CACHE_TTL = 6 * 60 * 60 * 1000;
const ERROR_CACHE_TTL = 5 * 60 * 1000;
const PAPER_API_BASE_URL = import.meta.env?.VITE_PAPER_API_BASE_URL?.replace(/\/$/, '') || '';
const REPORT_API_URL = import.meta.env?.VITE_REPORT_API_URL || (PAPER_API_BASE_URL ? `${PAPER_API_BASE_URL}/report/trends` : '');

function cacheKeyFor(timeframe, filters, periods) {
  const normalized = normalizeReportFilters(filters);
  return JSON.stringify({ timeframe, filters: normalized, periods });
}

function normalizeGroupedResponse(data) {
  return {
    total: Math.max(0, Number(data?.meta?.count ?? data?.total) || 0),
    groups: Array.isArray(data?.group_by) ? data.group_by : (data?.groups || []),
  };
}

async function fetchWorkerTrends(periods, filters) {
  const url = new URL(REPORT_API_URL);
  url.searchParams.set('from', periods.current.fromStr);
  url.searchParams.set('to', periods.current.toStr);
  url.searchParams.set('previous_from', periods.previous.fromStr);
  url.searchParams.set('previous_to', periods.previous.toStr);
  const normalized = normalizeReportFilters(filters);
  if (normalized.categories.length > 0) url.searchParams.set('categories', normalized.categories.join(','));
  if (normalized.countries.length > 0) url.searchParams.set('countries', normalized.countries.join(','));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Trend API error: ${response.status}`);
    const data = await response.json();
    return {
      current: normalizeGroupedResponse(data.current),
      previous: normalizeGroupedResponse(data.previous),
      transport: 'worker',
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchDirectPeriod(period, filters, forceRefresh) {
  const url = new URL('https://api.openalex.org/works');
  url.searchParams.set('filter', buildOpenAlexTrendFilter(period, filters));
  url.searchParams.set('group_by', 'topics.id');
  url.searchParams.set('per_page', '100');
  url.searchParams.set('mailto', 'app@papertok.io');
  const data = await openAlexJson(url.toString(), {
    timeoutMs: 10000,
    cacheTtlMs: forceRefresh ? 0 : ACTIVE_CACHE_TTL,
    staleIfError: true,
  });
  return normalizeGroupedResponse(data);
}

async function fetchDirectTrends(periods, filters, forceRefresh) {
  const [current, previous] = await Promise.all([
    fetchDirectPeriod(periods.current, filters, forceRefresh),
    fetchDirectPeriod(periods.previous, filters, forceRefresh),
  ]);
  return { current, previous, transport: 'direct' };
}

export async function getScientificTrends(timeframe = '7d', filters = {}, options = {}) {
  const currentDate = options.currentDate instanceof Date
    ? options.currentDate
    : new Date(options.currentDate || Date.now());
  const periods = getComparisonPeriods(timeframe, currentDate);
  const cacheKey = cacheKeyFor(timeframe, filters, periods);
  const cached = TREND_CACHE.get(cacheKey);
  const cacheTtl = cached?.data?.status === 'unavailable' ? ERROR_CACHE_TTL : ACTIVE_CACHE_TTL;
  if (!options.forceRefresh && cached && Date.now() - cached.timestamp < cacheTtl) return cached.data;

  try {
    let grouped;
    if (REPORT_API_URL) {
      try {
        grouped = await fetchWorkerTrends(periods, filters);
      } catch (error) {
        console.warn('[ScientificTrends] Worker unavailable, using direct OpenAlex fallback', error);
      }
    }
    if (!grouped) grouped = await fetchDirectTrends(periods, filters, Boolean(options.forceRefresh));

    const today = formatReportDate(currentDate);
    const trends = {
      ...computeScientificTrends(grouped.current, grouped.previous, {
        currentPeriod: periods.current,
        previousPeriod: periods.previous,
        provisional: timeframe === '24h' || periods.current.toStr === today,
      }),
      transport: grouped.transport,
    };
    TREND_CACHE.set(cacheKey, { timestamp: Date.now(), data: trends });
    return trends;
  } catch (error) {
    console.warn('[ScientificTrends] Unable to calculate trends', error);
    const unavailable = {
      status: 'unavailable',
      source: 'openalex',
      provisional: false,
      periods,
      items: [],
    };
    TREND_CACHE.set(cacheKey, { timestamp: Date.now(), data: unavailable });
    return unavailable;
  }
}
