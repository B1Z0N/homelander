// HistoryTab — chronological log of sent/failed listings.
// Filterable by outcome and search, grouped by date, with CSV export.

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useLocale } from '../locales/LocaleContext';
import { ExternalLinkIcon, RetryIcon } from '../shared/Icons';
import { swallow } from '../shared/logCatch.js';
import { useStore } from '../stores/appStore';
import { userErrorText, redact } from '../shared/userErrors';

const PAGE_SIZE = 30;
const OUTCOME_KEYS = [
  { value: '', label: 'All', localeKey: 'history.all', statKey: 'total', icon: null, color: null },
  { value: 'SENT', label: 'Sent', localeKey: 'history.sent', statKey: 'sent', icon: '●', color: 'var(--success)' },
  { value: 'FAIL', label: 'Failed', localeKey: 'history.failed', statKey: 'failed', icon: '●', color: 'var(--danger)' },
  { value: 'DEACTIVATED', label: 'Deactivated', localeKey: 'history.deactivated', statKey: 'deactivated', icon: '●', color: 'var(--text-secondary)' },
  { value: 'PREMIUM', label: 'Premium', localeKey: 'history.premiumLabel', statKey: 'premium', icon: '●', color: '#a855f7' },
  { value: 'CAPTCHA', label: 'Captcha', localeKey: 'history.captchaLabel', statKey: 'captcha', icon: '●', color: '#f59e0b' },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function formatDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';

    return d.toLocaleDateString('de-DE', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  } catch {
    return '';
  }
}

function formatDateTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleString('de-DE', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return '';
  }
}

function listingBadges(listing) {
  const failureReason = (listing.failure_reason || listing.failureReason || '').toLowerCase();
  const detail = (listing.detail || '').toLowerCase();
  const outcome = listing.outcome || '';
  const badges = [];
  if (outcome === 'DEACTIVATED' || failureReason.includes('deactivated') || detail.includes('deactivated')) badges.push('Deactivated');
  if (failureReason.includes('captcha') || detail.includes('captcha')) badges.push('Captcha');
  if (failureReason.includes('premium') || detail.includes('premium') || detail.includes('suchen+')) badges.push('Premium');
  return badges;
}

// ── Entry Row ────────────────────────────────────────────────────────────────

function HistoryEntry({ listing, isExpanded, onToggle, onRetry, retrying, onSupportBundle, supportBusy, outcomeFilter, onImageHover, onImageMove, onImageLeave, onTipShow, onTipMove, onTipHide }) {
  const { t } = useLocale();
  const [copied, setCopied] = useState(null);
  const [requeued, setRequeued] = useState(false);

  useEffect(() => {
    const handler = (e) => {
      if (e.detail?.exposeId === listing.expose_id) {
        setRequeued(true);
        setTimeout(() => setRequeued(false), 4000);
      }
    };
    window.addEventListener('homelander:retry-queued', handler);
    return () => window.removeEventListener('homelander:retry-queued', handler);
  }, [listing.expose_id]);

  const outcome = listing.outcome || 'FAILED';

  const isSent = outcome === 'SENT';
  const rawBadges = listingBadges(listing);
  // Use raw badges for outcome classification (must work regardless of active filter)
  const isDeactivated = rawBadges.includes('Deactivated');
  const isDryRun = outcome === 'DRY_RUN';
  const isPremium = rawBadges.includes('Premium');
  const isCaptcha = rawBadges.includes('Captcha');
  // Filtered badges for visual rendering only (suppress the badge matching active filter)
  const showBadges = outcomeFilter
    ? rawBadges.filter(b => b.toUpperCase() !== outcomeFilter.toUpperCase())
    : rawBadges;

  // Icon + color — premium/deactivated are their own outcomes, not generic "Failed"
  const statusIcon = isSent ? '✓' : isDeactivated ? '⊘' : isPremium ? '💎' : isDryRun ? '○' : '✗';
  const statusColor = isSent ? 'var(--success)' : isDeactivated ? 'var(--text-muted)' : isPremium ? '#a855f7' : isDryRun ? 'var(--text-muted)' : 'var(--danger)';

  const outcomeLabel = isSent ? t('history.sent', 'Sent') : isDeactivated ? t('history.deactivated', 'Deactivated') : isPremium ? t('history.premiumLabel', 'Premium') : isDryRun ? t('history.dryRun', 'Dry Run') : t('history.failed', 'Failed');

  const badgeClass = isSent ? 'badge-success' : isDeactivated ? 'badge-deactivated' : isPremium ? 'badge-premium' : isDryRun ? '' : 'badge-fail';
  const safeDetail = listing.detail ? userErrorText(listing.detail, { operation: 'listing apply' }, t) : '';
  const isError = outcome === 'ERROR';
  const rawDetail = isError && listing.detail ? redact(listing.detail) : '';
  const hasRawDetail = rawDetail && rawDetail !== safeDetail;
  const detailCopyText = hasRawDetail ? `${safeDetail}\n\n${rawDetail}` : safeDetail;

  return (
    <div
      className="card cursor-pointer select-none"
      onClick={() => onToggle(listing.expose_id)}
    >
      {/* Summary row */}
      <div className="flex items-center gap-3 px-3 py-2.5">
        {/* Thumbnail — always show placeholder, overlay image when available */}
        <div className="relative flex-shrink-0" style={{ width: 40, height: 40 }}>
          <div
            className="absolute inset-0 rounded bg-gray-700 flex items-center justify-center text-gray-500 text-xs font-medium"
          >
            {(listing.title || '?')[0]}
          </div>
          {listing.image_url && (
            <img
              src={listing.image_url}
              alt=""
              className="absolute inset-0 rounded object-cover bg-gray-700"
              style={{ width: 40, height: 40 }}
              loading="lazy"
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
              onMouseEnter={(e) => {
                onImageHover?.(listing.image_url);
                onImageMove?.({ x: e.clientX, y: e.clientY });
              }}
              onMouseMove={(e) => onImageMove?.({ x: e.clientX, y: e.clientY })}
              onMouseLeave={() => onImageLeave?.()}
            />
          )}
        </div>
        {/* Status icon */}
        <span
          className={`flex-shrink-0 w-5 text-center ${isDeactivated ? 'text-base' : 'text-sm'}`}
          style={{ color: statusColor }}
        >
          {statusIcon}
        </span>

        {/* Title + address */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate">
              {listing.title || t('history.unknownListing', 'Unknown Listing')}
            </span>
            <span
              className={`badge ${badgeClass} text-xs`}
              onMouseEnter={(e) => {
                e.stopPropagation();
                const tipKey = isSent ? 'sentTip' : isPremium ? 'premiumTip' : isDeactivated ? 'deactivatedTip' : isCaptcha ? 'captchaTip' : 'failedTip';
                onTipShow(t(`history.${tipKey}`, t(`livefeed.${tipKey}`, '')), e);
              }}
              onMouseMove={(e) => { e.stopPropagation(); onTipMove(e); }}
              onMouseLeave={onTipHide}
            >
              {outcomeLabel}
            </span>
            {showBadges.includes('Deactivated') && listing.outcome !== 'DEACTIVATED' && (
              <span className="badge badge-deactivated text-xs" onMouseEnter={(e) => { e.stopPropagation(); onTipShow(t('history.deactivatedTip'), e); }} onMouseMove={(e) => { e.stopPropagation(); onTipMove(e); }} onMouseLeave={onTipHide}>{t('history.deactivatedBadge', '🪦 Deactivated')}</span>
            )}
            {showBadges.includes('Captcha') && (
              <span className="badge badge-captcha text-xs" onMouseEnter={(e) => { e.stopPropagation(); onTipShow(t('history.captchaTip'), e); }} onMouseMove={(e) => { e.stopPropagation(); onTipMove(e); }} onMouseLeave={onTipHide}>{t('history.captchaBadge', '🔐 Captcha')}</span>
            )}
            {showBadges.includes('Premium') && listing.outcome !== 'PREMIUM' && (
              <span className="badge badge-premium text-xs" onMouseEnter={(e) => { e.stopPropagation(); onTipShow(t('history.premiumTip'), e); }} onMouseMove={(e) => { e.stopPropagation(); onTipMove(e); }} onMouseLeave={onTipHide}>{t('history.premiumBadge', '💎 Premium')}</span>
            )}
          </div>
          {listing.address && (
            <p className="text-xs truncate mt-0.5" style={{ color: 'var(--text-muted)' }}>
              {listing.address}
            </p>
          )}
        </div>

        {/* Open in controlled Chromium */}
        {listing.expose_id && (
          <button
            className="btn btn-ghost flex-shrink-0"
            style={{ color: 'var(--accent)', padding: '2px 6px', fontSize: '16px' }}
            onClick={(e) => { e.stopPropagation(); window.homelander?.openListingInChrome?.(listing.expose_id); }}
            onMouseEnter={(e) => onTipShow(t('history.openInChrome', 'Open in Homelander Chromium'), e)}
            onMouseMove={onTipMove}
            onMouseLeave={onTipHide}
          >
            <ExternalLinkIcon size={16} />
          </button>
        )}

        {/* Retry button */}
        {!isSent && !isDeactivated && listing.expose_id && onRetry && (
          requeued ? (
            <span className="text-xs flex-shrink-0" style={{ color: 'var(--success)' }}>{t('history.requeued', 'Re-queued →')}</span>
          ) : (
            <button
              className="btn btn-ghost flex-shrink-0"
              onClick={(e) => { e.stopPropagation(); onRetry(listing.expose_id); }}
              disabled={retrying?.has(listing.expose_id)}
              style={{ color: 'var(--accent)', padding: '2px 6px', fontSize: '16px' }}
              onMouseEnter={(e) => onTipShow(t('history.retryThis', 'Retry this listing'), e)}
              onMouseMove={onTipMove}
              onMouseLeave={onTipHide}
            >
              <RetryIcon size={14} />
            </button>
          )
        )}

        {/* Time */}
        <span className="text-xs flex-shrink-0 w-12 text-right" style={{ color: 'var(--text-muted)' }}>
          {formatTime(listing.sent_at)}
        </span>

        {/* Expand chevron */}
        <span
          className="text-xs flex-shrink-0 transition-transform"
          style={{
            color: 'var(--text-muted)',
            transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
          }}
        >
          ▶
        </span>
      </div>

      {/* Expanded detail */}
      {isExpanded && (
        <div
          className="px-3 pb-3 pt-1 border-t mx-3"
          style={{ borderColor: 'var(--border)' }}
        >
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs mt-2">
            <div>
              <span style={{ color: 'var(--text-muted)' }}>{t('history.status', 'Status:')} </span>
              <span className={`badge badge-${badgeClass.replace('badge-', '')} text-xs`}>
                {outcomeLabel}
              </span>
            </div>

            <div>
              <span style={{ color: 'var(--text-muted)' }}>{t('history.time', 'Time:')} </span>
              <span style={{ color: 'var(--text-secondary)' }}>
                {formatDateTime(listing.sent_at)}
              </span>
            </div>

            {listing.expose_id && (
              <div className="col-span-2">
                <span style={{ color: 'var(--text-muted)' }}>{t('history.exposeId', 'Exposé ID:')} </span>
                <button
                  className="font-mono"
                  style={{ color: copied === listing.expose_id ? 'var(--success)' : 'var(--text-secondary)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    navigator.clipboard.writeText(listing.expose_id).catch((err) => { swallow(err, 'renderer/clipboard-expose-id'); });
                    setCopied(listing.expose_id);
                    setTimeout(() => setCopied(null), 1500);
                  }}
                  title={t('history.clickToCopy', 'Click to copy')}
                >
                  {listing.expose_id}
                </button>
                <span
                  className="ml-2 text-xs"
                  style={{ color: copied === listing.expose_id ? 'var(--success)' : 'var(--text-muted)', cursor: 'pointer' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    navigator.clipboard.writeText(listing.expose_id).catch((err) => { swallow(err, 'renderer/clipboard-expose-id'); });
                    setCopied(listing.expose_id);
                    setTimeout(() => setCopied(null), 1500);
                  }}
                  title={t('history.clickToCopy', 'Click to copy')}
                >
                  {copied === listing.expose_id ? t('history.copied', '✓ Copied') : t('history.copyIcon', '📋')}
                </span>
              </div>
            )}

            {safeDetail && (
              <div className="col-span-2 mt-1">
                <span style={{ color: 'var(--text-muted)' }}>{t('history.detail', 'Detail:')} </span>
                <p
                  className="mt-0.5 p-2 rounded text-xs whitespace-pre-wrap"
                  style={{
                    background: 'var(--bg-secondary)',
                    color: copied === detailCopyText ? 'var(--success)' : 'var(--text-secondary)',
                    border: '1px solid var(--border)',
                    cursor: 'pointer',
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    navigator.clipboard.writeText(detailCopyText).catch((err) => { swallow(err, 'renderer/clipboard-detail'); });
                    setCopied(detailCopyText);
                    setTimeout(() => setCopied(null), 1500);
                  }}
                  onMouseEnter={hasRawDetail ? (e) => { e.stopPropagation(); onTipShow(rawDetail, e); } : undefined}
                  onMouseMove={hasRawDetail ? (e) => { e.stopPropagation(); onTipMove(e); } : undefined}
                  onMouseLeave={hasRawDetail ? onTipHide : undefined}
                  title={hasRawDetail ? undefined : t('history.clickToCopy', 'Click to copy')}
                >
                  {safeDetail}
                </p>
              </div>
            )}

            {listing.expose_id && onSupportBundle && (
              <div className="col-span-2">
                <button
                  className="btn btn-ghost text-xs"
                  style={{ color: supportBusy ? 'var(--success)' : 'var(--accent)', padding: '3px 8px' }}
                  onClick={(e) => { e.stopPropagation(); if (!supportBusy) onSupportBundle(listing); }}
                  disabled={supportBusy}
                >
                  {supportBusy ? t('history.supportExported', '✓ Debug bundle exported') : t('history.supportExport', '📦 Export Debug Bundle')}
                </button>
                <span className="ml-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                  {t('history.supportDesc', 'screenshot + HTML + entry logs')}
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Component ───────────────────────────────────────────────────────────

export default function HistoryTab() {
  const { t } = useLocale();
  const filters = useStore((state) => state.filters);
  const activeTab = useStore((state) => state.activeTab);

  const [listings, setListings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [outcomeFilter, setOutcomeFilter] = useState('');
  const [filterId, setFilterId] = useState('');
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [expandedIds, setExpandedIds] = useState(new Set());
  const [loadingMore, setLoadingMore] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [supportBusyId, setSupportBusyId] = useState(null);
  const [allTimeStats, setAllTimeStats] = useState(null);
  const [retrying, setRetrying] = useState(new Set());
  const [retryAllBusy, setRetryAllBusy] = useState(false);
  const [retryAllDone, setRetryAllDone] = useState(false);
  const sentinelRef = useRef(null);
  const fetchListingsRef = useRef(null);
  const [hoveredImage, setHoveredImage] = useState(null);
  const [hoverPos, setHoverPos] = useState({ x: 0, y: 0 });
  const [tip, setTip] = useState(null);
  const activeTipTargetRef = useRef(null);

  const hideTip = useCallback(() => {
    activeTipTargetRef.current = null;
    setTip(null);
  }, []);

  const showTip = useCallback((text, e) => {
    if (!text || !e?.currentTarget) {
      hideTip();
      return;
    }
    activeTipTargetRef.current = e.currentTarget;
    setTip({ text, x: e.clientX, y: e.clientY });
  }, [hideTip]);

  const moveTip = useCallback((e) => {
    const target = activeTipTargetRef.current || e?.currentTarget;
    if (!target || !e) return;
    activeTipTargetRef.current = target;
    const rect = target.getBoundingClientRect();
    if (
      e.clientX < rect.left ||
      e.clientX > rect.right ||
      e.clientY < rect.top ||
      e.clientY > rect.bottom
    ) {
      hideTip();
      return;
    }
    setTip(prev => prev ? { ...prev, x: e.clientX, y: e.clientY } : null);
  }, [hideTip]);

  useEffect(() => {
    const handleWindowMouseMove = (e) => {
      const target = activeTipTargetRef.current;
      if (!target) return;
      const rect = target.getBoundingClientRect();
      if (
        e.clientX < rect.left ||
        e.clientX > rect.right ||
        e.clientY < rect.top ||
        e.clientY > rect.bottom
      ) {
        hideTip();
      }
    };

    const handleWindowBlur = () => {
      if (activeTipTargetRef.current) hideTip();
    };
    const handleWindowScroll = () => {
      if (activeTipTargetRef.current) hideTip();
    };

    window.addEventListener('mousemove', handleWindowMouseMove, true);
    window.addEventListener('blur', handleWindowBlur);
    window.addEventListener('scroll', handleWindowScroll, true);

    return () => {
      window.removeEventListener('mousemove', handleWindowMouseMove, true);
      window.removeEventListener('blur', handleWindowBlur);
      window.removeEventListener('scroll', handleWindowScroll, true);
    };
  }, [hideTip]);

  // ── Load stats (optionally filtered by search) ─────────────────────────────
  const loadStats = useCallback((forFilterId) => {
    if (!window.homelander) return;
    window.homelander.getStats(forFilterId || undefined).then(({ stats, error }) => {
      if (!error && stats) setAllTimeStats(stats);
    }).catch((err) => { swallow(err, 'renderer/retry-listing'); });
  }, []);

  // ── Fetch listings ───────────────────────────────────────────────────────
  const fetchListings = useCallback(
    async (append = false) => {
      if (!window.homelander) {
        setError(userErrorText('Backend unavailable', { code: 'BACKEND_UNAVAILABLE' }, t));
        setLoading(false);
        return;
      }

      const currentOffset = append ? offset : 0;

      if (!append) {
        setLoading(true);
      } else {
        setLoadingMore(true);
      }
      setError(null);

      const { listings: newListings, error: apiError } =
        await window.homelander.getHistory(
          PAGE_SIZE,
          currentOffset,
          filterId || null,
          outcomeFilter || null
        );

      if (apiError) {
        setError(apiError);
        setLoading(false);
        setLoadingMore(false);
        return;
      }

      const items = newListings || [];

      if (append) {
        setListings((prev) => [...prev, ...items]);
        setOffset((prev) => prev + items.length);
      } else {
        setListings(items);
        setOffset(items.length);
      }

      setHasMore(items.length >= PAGE_SIZE);
      setLoading(false);
      setLoadingMore(false);
    },
    [outcomeFilter, filterId, offset]
  );

  fetchListingsRef.current = fetchListings;

  useEffect(() => {
    if (activeTab === 'history') {
      loadStats(filterId);
      fetchListingsRef.current?.(false);
    }
  }, [activeTab, filterId, loadStats]);

  // Listen for daemon listing events — refresh stats + listings while tab is active.
  useEffect(() => {
    if (!window.homelander) return;
    const unsubListing = window.homelander.onListing(() => {
      if (activeTab === 'history') {
        loadStats(filterId);
        fetchListingsRef.current?.(false);
      }
    });
    // Also refresh when a retry is queued — the listing's outcome was cleared
    // and should disappear from the current filter view immediately.
    const onRetryQueued = () => {
      if (activeTab === 'history') {
        loadStats(filterId);
        fetchListingsRef.current?.(false);
      }
    };
    window.addEventListener('homelander:retry-queued', onRetryQueued);
    return () => {
      unsubListing();
      window.removeEventListener('homelander:retry-queued', onRetryQueued);
    };
  }, [activeTab, filterId, loadStats]);

  // Reset and reload when filters change
  useEffect(() => {
    setExpandedIds(new Set());
    setListings([]);        // clear old data so badges don't flash during reload
    setOffset(0);
    fetchListings(false);
    loadStats(filterId);
  }, [outcomeFilter, filterId, loadStats]);

  // ── Infinite scroll (IntersectionObserver) ────────────────────────────────

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loading && !loadingMore) {
          fetchListings(true);
        }
      },
      { rootMargin: '200px' }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loading, loadingMore, fetchListings]);

  // ── Toggle expand ────────────────────────────────────────────────────────

  const toggleExpand = useCallback((id) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleRetry = useCallback(async (exposeId) => {
    if (!window.homelander) return;
    setRetrying(prev => new Set(prev).add(exposeId));
    try {
      const result = await window.homelander.retryListing(exposeId);
      if (!result?.ok) {
        throw new Error(result?.error || t('history.retryFailed', 'Retry failed'));
      }
      if (result.queued) {
        window.dispatchEvent(new CustomEvent('homelander:retry-queued', { detail: { exposeId } }));
      }
      // Running daemon confirms asynchronously via retry_queued event.
    } catch (err) { swallow(err, 'renderer/retry-queue-event'); }
    setTimeout(() => setRetrying(prev => {
      const next = new Set(prev); next.delete(exposeId); return next;
    }), 2000);
  }, []);

  const handleRetryAllFailed = useCallback(async () => {
    if (!window.homelander) return;
    setRetryAllBusy(true);
    setRetryAllDone(false);
    try {
      await window.homelander.retryAllFailed(filterId || null);
      setRetryAllDone(true);
      // Refresh the list — failed should disappear
      fetchListingsRef.current?.(false);
      loadStats(filterId);
      setTimeout(() => setRetryAllDone(false), 3000);
    } catch (err) { swallow(err, 'renderer/retry-all-failed'); }
    finally {
      setRetryAllBusy(false);
    }
  }, [filterId, loadStats]);

  const handleSupportBundle = useCallback(async (listing) => {
    const exposeId = listing?.expose_id;
    if (!window.homelander?.createSupportBundle || !exposeId) return;
    setSupportBusyId(exposeId);
    try {
      await window.homelander.createSupportBundle({ scope: 'entry', listing });
    } catch (err) { swallow(err, 'renderer/retry-queue-event'); }
    setTimeout(() => setSupportBusyId(null), 1500);
  }, []);

  // ── Load all-time stats
  const exportCSV = useCallback(async () => {
    if (!window.homelander) return;
    setExporting(true);
    setError(null);
    try {
      const { listings: exportRows, error: apiError } = await window.homelander.getHistory(
        1000000,
        0,
        filterId || null,
        outcomeFilter || null
      );
      if (apiError) throw { userError: apiError.userError, message: apiError };
      const rowsToExport = exportRows || [];
      if (rowsToExport.length === 0) return;

      const escapeCsv = (value) => {
        const s = String(value ?? '');
        // Formula injection guard: prefix cells starting with = + - @
        const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
        return `"${safe.replace(/"/g, '""')}"`;
      };
      const header = 'expose_id,title,address,outcome,badges,detail,sent_at,filter_id';
      const rows = rowsToExport
        .map((l) => {
          const outcome = l.outcome || '';
          const badges = listingBadges(l)
            .filter(b => !outcomeFilter || b.toUpperCase() !== outcomeFilter.toUpperCase())
            .join('; ');
          return [
            l.expose_id || '',
            escapeCsv(l.title),
            escapeCsv(l.address),
            outcome,
            escapeCsv(badges),
            escapeCsv(l.detail),
            l.sent_at || '',
            l.filter_id || '',
          ].join(',');
        })
        .join('\n');

      const csv = header + '\n' + rows;
      const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);

      const filterName = filterId ? (filters.find((f) => f.id === filterId)?.name || filterId).replace(/[^a-z0-9_-]+/gi, '-') : 'all-searches';
      const outcomeName = outcomeFilter || 'all-outcomes';
      const link = document.createElement('a');
      link.href = url;
      link.download = `homelander-history-${filterName}-${outcomeName}-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(userErrorText(err.userError || err, { operation: 'csv export' }, t));
    } finally {
      setExporting(false);
    }
  }, [filterId, outcomeFilter, filters]);

  // ── Group listings by date ────────────────────────────────────────────────

  const grouped = React.useMemo(() => {
    const groups = new Map();
    for (const listing of listings) {
      const dateKey = formatDate(listing.sent_at);
      if (!groups.has(dateKey)) {
        groups.set(dateKey, []);
      }
      groups.get(dateKey).push(listing);
    }
    return groups;
  }, [listings]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full">
      {/* Stats label — reflects active search filter */}
      <div className="flex items-center gap-3 mb-3 flex-shrink-0">
        <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
          {filterId ? (filters.find(f => f.id === filterId)?.name || t('history.searchFallback', 'Search')) : t('history.allTime', 'All time')}
        </span>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-2 mb-3 flex-shrink-0">
        {/* Outcome filter */}
        <div className="flex gap-1">
          {OUTCOME_KEYS.map((o) => {
            const count = allTimeStats ? allTimeStats[o.statKey] : null;
            const label = count != null ? `${t(o.localeKey, o.label)} ${count}` : t(o.localeKey, o.label);
            const isActive = outcomeFilter === o.value;
            return (
              <button
                key={o.value}
                className="btn btn-ghost text-xs px-2 py-1.5 whitespace-nowrap"
                style={
                  isActive
                    ? {
                        background: 'var(--accent)',
                        color: 'white',
                      }
                    : o.color
                      ? { color: o.color }
                      : { color: 'var(--accent)' }
                }
                onClick={() => {
                  if (outcomeFilter !== o.value) setListings([]);
                  setOutcomeFilter(o.value);
                }}
              >
                {label}
              </button>
            );
          })}
        </div>

        <div className="flex-1" />

        {/* Search filter dropdown */}
        <div className="relative">
          <select
            className="select text-xs py-1.5 px-2"
            style={{ minWidth: 55, maxWidth: 150 }}
            value={filterId}
            onChange={(e) => setFilterId(e.target.value)}
          >
            <option value="">{t('history.all', 'All searches')}</option>
            {filters.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name || t('history.searchFallback', 'Search') + ' ' + f.id}
              </option>
            ))}
          </select>
        </div>

        {/* Retry All Failed button — visible only when Failed filter active */}
        {outcomeFilter === 'FAIL' && (allTimeStats?.failed ?? 0) > 0 && (
          <button
            className="btn btn-ghost flex-shrink-0"
            onClick={handleRetryAllFailed}
            disabled={retryAllBusy}
            onMouseEnter={(e) => showTip(t('history.retryAllTip', 'Retry all failed listings for this search'), e)}
            onMouseMove={moveTip}
            onMouseLeave={hideTip}
            style={retryAllDone ? { background: 'var(--success)', color: 'white', padding: '2px 6px', fontSize: '16px' } : { color: 'var(--accent)', padding: '2px 6px', fontSize: '16px' }}
          >
            <span style={{ fontSize: '24px' }}>{retryAllDone ? '✓' : <RetryIcon size={14} />}</span>
          </button>
        )}

        {/* Export button */}
        <button
          className="btn btn-secondary text-xs"
          onClick={exportCSV}
          disabled={exporting || (allTimeStats?.total ?? listings.length) === 0}
        >
          {exporting ? t('history.exporting', 'Exporting…') : t('history.exportCsv', '⬇ Export')}
        </button>
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-y-auto">
        {/* Loading state */}
        {loading && (
          <div className="py-12 text-center" style={{ color: 'var(--text-muted)' }}>
            <p className="text-sm">{t('history.loading', 'Loading history…')}</p>
          </div>
        )}

        {/* Error state */}
        {error && !loading && (
          <div className="py-12 text-center">
            <p className="text-sm" style={{ color: 'var(--danger)' }}>
              ⚠ {error}
            </p>
            <button
              className="btn btn-secondary text-xs mt-3"
              onClick={() => fetchListings(false)}
            >
              {t('history.retry', 'Retry')}
            </button>
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && listings.length === 0 && (
          <div className="py-12 text-center" style={{ color: 'var(--text-muted)' }}>
            <p className="text-sm">{t('history.emptyState', 'No history yet.')}</p>
            <p className="text-xs mt-1">{t('history.emptyHint', 'Sent and failed listings will appear here.')}</p>
          </div>
        )}

        {/* Listings grouped by date */}
        {!loading && !error && listings.length > 0 && (
          <div className="space-y-4">
            {[...grouped.entries()].map(([date, items]) => (
              <div key={date}>
                {/* Date header */}
                <h3
                  className="text-xs font-semibold uppercase tracking-wide mb-2 px-1"
                  style={{ color: 'var(--text-muted)' }}
                >
                  {date === 'Today' ? t('history.today', 'Today') : date === 'Yesterday' ? t('history.yesterday', 'Yesterday') : date}
                </h3>

                {/* Entries for this date */}
                <div className="space-y-1">
                  {items.map((listing) => (
                    <HistoryEntry
                      key={listing.expose_id || listing.sent_at}
                      listing={listing}
                      isExpanded={expandedIds.has(listing.expose_id)}
                      onToggle={toggleExpand}
                      onRetry={handleRetry}
                      retrying={retrying}
                      onSupportBundle={handleSupportBundle}
                      supportBusy={supportBusyId === listing.expose_id}
                      outcomeFilter={outcomeFilter}
                      onImageHover={setHoveredImage}
                      onImageMove={setHoverPos}
                      onImageLeave={() => setHoveredImage(null)}
                      onTipShow={showTip}
                      onTipMove={moveTip}
                      onTipHide={hideTip}
                    />
                  ))}
                </div>
              </div>
            ))}

            {/* Infinite scroll sentinel */}
            <div ref={sentinelRef} className="h-1" />

            {/* Loading more indicator */}
            {loadingMore && (
              <div className="py-4 text-center" style={{ color: 'var(--text-muted)' }}>
                <p className="text-xs">{t('history.loadingMore', 'Loading more…')}</p>
              </div>
            )}

            {/* End of list */}
            {!hasMore && listings.length > PAGE_SIZE && (
              <div
                className="py-4 text-center text-xs"
                style={{ color: 'var(--text-muted)' }}
              >
                {t('history.endOfHistory', '— End of history —')}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Badge tooltip — instant hover */}
      {tip && (
        <div
          className="fixed pointer-events-none z-50 px-3 py-1.5 rounded-lg text-xs font-medium shadow-lg"
          style={{
            left: tip.x + 14,
            top: tip.y - 36,
            background: 'var(--bg-secondary)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border)',
            maxWidth: 320,
            whiteSpace: 'normal',
          }}
        >
          {tip.text}
        </div>
      )}

      {/* Hover preview */}
      {hoveredImage && (
        <div
          className="fixed pointer-events-none z-50"
          style={{
            left: hoverPos.x + 16,
            top: hoverPos.y - 80,
          }}
        >
          <img
            src={hoveredImage}
            alt="Preview"
            className="rounded shadow-lg object-cover"
            style={{ width: 360, height: 270, background: 'var(--bg-primary)' }}
            onError={(e) => { e.currentTarget.style.display = 'none'; }}
          />
        </div>
      )}
    </div>
  );
}
