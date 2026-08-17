// Activity feed — live-scrolling list of sent/failed listings.
// Each entry is clickable: expands to show detail + IS24 link.

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useLocale } from '../locales/LocaleContext';
import { swallow } from '../shared/logCatch.js';
import { useStore } from '../stores/appStore';
import { ExternalLinkIcon, RetryIcon } from '../shared/Icons';
import { userErrorText, redact } from '../shared/userErrors';

function formatTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function formatDateTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

export default function ActivityFeed() {
  const { t } = useLocale();
  const activity = useStore((s) => s.activity);
  const [expanded, setExpanded] = useState(new Set());
  const [retrying, setRetrying] = useState(new Set());
  const [supportBusyId, setSupportBusyId] = useState(null);
  const [copied, setCopied] = useState(null);
  const [requeued, setRequeued] = useState(new Set());
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

  // Listen for daemon retry_queued events
  useEffect(() => {
    const handler = (e) => {
      if (e.detail?.exposeId) {
        setRequeued(prev => new Set(prev).add(e.detail.exposeId));
        setTimeout(() => setRequeued(prev => {
          const next = new Set(prev); next.delete(e.detail.exposeId); return next;
        }), 4000);
      }
    };
    window.addEventListener('homelander:retry-queued', handler);
    return () => window.removeEventListener('homelander:retry-queued', handler);
  }, []);

  const toggle = useCallback((key) => {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
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
      const next = new Set(prev);
      next.delete(exposeId);
      return next;
    }), 2000);
  }, []);

  const handleCopy = useCallback(async (text) => {
    try { await navigator.clipboard.writeText(text); } catch (err) { swallow(err, 'renderer/clipboard'); }
    setCopied(text);
    setTimeout(() => setCopied(null), 1500);
  }, []);

  const handleSupportBundle = useCallback(async (item, exposeId) => {
    if (!window.homelander?.createSupportBundle || !exposeId) return;
    setSupportBusyId(exposeId);
    try {
      await window.homelander.createSupportBundle({
        scope: 'entry',
        listing: {
          expose_id: exposeId,
          title: item.title,
          address: item.address,
          outcome: item.outcome,
          detail: item.detail,
          failure_reason: item.failureReason || item.failure_reason,
          sent_at: item.time,
          image_url: item.imageUrl,
        },
      });
    } catch (err) { swallow(err, 'renderer/retry-queue-event'); }
    setTimeout(() => setSupportBusyId(null), 1500);
  }, []);

  if (activity.length === 0) {
    return (
      <div className="py-8 text-center" style={{ color: 'var(--text-muted)' }}>
        <p className="text-sm">{t('livefeed.empty', 'No activity yet.')}</p>
        <p className="text-xs mt-1">{t('livefeed.emptyHint', 'Add a search to start finding listings.')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {activity.slice(0, 100).map((item, i) => {
        const key = `${item.time}-${i}`;
        const exposeId = item.exposeId || item.expose_id;
        const failureReason = item.failureReason || item.failure_reason || '';
        const isExpanded = expanded.has(key);
        const isSent = item.outcome === 'SENT';
        const isDeactivated = item.outcome === 'DEACTIVATED'
          || failureReason.toLowerCase().includes('deactivated')
          || (item.detail || '').toLowerCase().includes('deactivated');
        const isPremium = (item.detail || '').toLowerCase().includes('premium')
          || (item.detail || '').toLowerCase().includes('suchen+')
          || failureReason.toLowerCase().includes('premium');
        const isCaptcha = (item.detail || '').toLowerCase().includes('captcha')
          || failureReason.toLowerCase().includes('captcha');
        const isError = item.outcome === 'ERROR';
        const safeDetail = item.detail ? userErrorText(item.detail, { operation: 'listing apply' }, t) : '';
        const rawDetail = isError && item.detail ? redact(item.detail) : '';
        const hasRawDetail = rawDetail && rawDetail !== safeDetail;
        const detailCopyText = hasRawDetail ? `${safeDetail}\n\n${rawDetail}` : safeDetail;
        const statusColor = isSent ? 'var(--success)' : isDeactivated ? 'var(--text-muted)' : isPremium ? '#a855f7' : 'var(--danger)';
        const statusIcon = isSent ? '✓' : isDeactivated ? '⊘' : isPremium ? '💎' : '✗';
        const outcomeLabel = isSent ? t('livefeed.sent', 'Sent') : isDeactivated ? t('livefeed.deactivated', 'Deactivated') : isPremium ? t('livefeed.premium', 'Premium') : t('livefeed.failed', 'Failed');
        const badgeClass = isSent ? 'success' : isDeactivated ? 'deactivated' : isPremium ? 'premium' : 'fail';

        return (
          <div
            key={key}
            className="card cursor-pointer select-none"
            onClick={() => toggle(key)}
          >
            {/* Summary row */}
            <div className="flex items-center gap-3 px-3 py-2">
              {/* Thumbnail — always show placeholder, overlay image when available */}
              <div className="relative flex-shrink-0" style={{ width: 40, height: 40 }}>
                <div
                  className="absolute inset-0 rounded bg-gray-700 flex items-center justify-center text-gray-500 text-xs font-medium"
                >
                  {(item.title || '?')[0]}
                </div>
                {item.imageUrl && (
                  <img
                    src={item.imageUrl}
                    alt=""
                    className="absolute inset-0 rounded object-cover bg-gray-700"
                    style={{ width: 40, height: 40 }}
                    loading="lazy"
                    onError={(e) => { e.currentTarget.style.display = 'none'; }}
                    onMouseEnter={(e) => {
                      setHoveredImage(item.imageUrl);
                      setHoverPos({ x: e.clientX, y: e.clientY });
                    }}
                    onMouseMove={(e) => setHoverPos({ x: e.clientX, y: e.clientY })}
                    onMouseLeave={() => setHoveredImage(null)}
                  />
                )}
              </div>
              {/* Status icon */}
              <span className={`flex-shrink-0 w-5 text-center ${isDeactivated ? 'text-base' : 'text-sm'}`} style={{ color: statusColor }}>
                {statusIcon}
              </span>

              {/* Title + address */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate">
                    {item.title || t('livefeed.unknownListing', 'Unknown Listing')}
                  </span>
                  <span
                    className={`badge badge-${badgeClass} text-xs`}
                    onMouseEnter={(e) => {
                      e.stopPropagation();
                      const tipKey = isSent ? 'sentTip' : isPremium ? 'premiumTip' : isDeactivated ? 'deactivatedTip' : isCaptcha ? 'captchaTip' : 'failedTip';
                      showTip(t(`livefeed.${tipKey}`, ''), e);
                    }}
                    onMouseMove={moveTip}
                    onMouseLeave={hideTip}
                  >
                    {outcomeLabel}
                  </span>
                  {isDeactivated && item.outcome !== 'DEACTIVATED' && (
                    <span className="badge badge-deactivated text-xs" onMouseEnter={(e) => { e.stopPropagation(); showTip(t('livefeed.deactivatedTip'), e); }} onMouseMove={moveTip} onMouseLeave={hideTip}>{t('livefeed.deactivatedBadge', '🪦 Deactivated')}</span>
                  )}
                  {isCaptcha && (
                    <span className="badge badge-captcha text-xs" onMouseEnter={(e) => { e.stopPropagation(); showTip(t('livefeed.captchaTip'), e); }} onMouseMove={moveTip} onMouseLeave={hideTip}>{t('livefeed.captchaBadge', '🔐 Captcha')}</span>
                  )}
                  {isPremium && item.outcome !== 'PREMIUM' && (
                    <span className="badge badge-premium text-xs" onMouseEnter={(e) => { e.stopPropagation(); showTip(t('livefeed.premiumTip'), e); }} onMouseMove={moveTip} onMouseLeave={hideTip}>{t('livefeed.premiumBadge', '💎 Premium')}</span>
                  )}
                </div>
                {item.address && (
                  <p className="text-xs truncate mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    {item.address}
                  </p>
                )}
              </div>

              {/* Open in controlled Chromium */}
              {exposeId && (
                <button
                  className="btn btn-ghost flex-shrink-0"
                  style={{ color: 'var(--accent)', padding: '2px 6px', fontSize: '16px' }}
                  onClick={(e) => { e.stopPropagation(); window.homelander?.openListingInChrome?.(exposeId); }}
                  onMouseEnter={(e) => showTip(t('livefeed.openInChrome', 'Open in Homelander Chromium'), e)}
                  onMouseMove={moveTip}
                  onMouseLeave={hideTip}
                >
                  <ExternalLinkIcon size={16} />
                </button>
              )}

              {/* Retry button (visible on summary row for quick access) */}
              {!isSent && !isDeactivated && exposeId && (
                requeued.has(exposeId) ? (
                  <span className="text-xs flex-shrink-0" style={{ color: 'var(--success)' }}>{t('livefeed.requeued', 'Re-queued →')}</span>
                ) : (
                  <button
                    className="btn btn-ghost flex-shrink-0"
                    onClick={(e) => { e.stopPropagation(); handleRetry(exposeId); }}
                    disabled={retrying.has(exposeId)}
                    style={{ color: 'var(--accent)', padding: '2px 6px', fontSize: '16px' }}
                    onMouseEnter={(e) => showTip(t('livefeed.retryThis', 'Retry this listing'), e)}
                    onMouseMove={moveTip}
                    onMouseLeave={hideTip}
                  >
                    <RetryIcon size={14} />
                  </button>
                )
              )}

              {/* Time */}
              <span className="text-xs flex-shrink-0 w-12 text-right" style={{ color: 'var(--text-muted)' }}>
                {formatTime(item.time)}
              </span>

              {/* Expand chevron */}
              <span className="text-xs flex-shrink-0 transition-transform" style={{
                color: 'var(--text-muted)',
                transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
              }}>▶</span>
            </div>

            {/* Expanded detail */}
            {isExpanded && (
              <div className="px-3 pb-3 pt-1 border-t mx-3" style={{ borderColor: 'var(--border)' }}>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs mt-2">
                  <div>
                    <span style={{ color: 'var(--text-muted)' }}>{t('livefeed.status', 'Status:')} </span>
                    <span className={`badge badge-${badgeClass} text-xs`}>{outcomeLabel}</span>
                  </div>
                  <div>
                    <span style={{ color: 'var(--text-muted)' }}>{t('livefeed.time', 'Time:')} </span>
                    <span style={{ color: 'var(--text-secondary)' }}>{formatDateTime(item.time)}</span>
                  </div>

                  {exposeId && (
                    <div className="col-span-2">
                      <span style={{ color: 'var(--text-muted)' }}>{t('livefeed.exposeId', 'Exposé ID:')} </span>
                      <button
                        className="font-mono"
                        style={{ color: copied === exposeId ? 'var(--success)' : 'var(--text-secondary)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                        onClick={(e) => { e.stopPropagation(); handleCopy(exposeId); }}
                        title={t('livefeed.clickToCopy', 'Click to copy')}
                      >
                        {exposeId}
                      </button>
                      <span
                        className="ml-2 text-xs"
                        style={{ color: copied === exposeId ? 'var(--success)' : 'var(--text-muted)', cursor: 'pointer' }}
                        onClick={(e) => { e.stopPropagation(); handleCopy(exposeId); }}
                        title={t('livefeed.clickToCopy', 'Click to copy')}
                      >
                        {copied === exposeId ? t('livefeed.copied', '✓ Copied') : t('livefeed.copyIcon', '📋')}
                      </span>
                    </div>
                  )}

                  {safeDetail && (
                    <div className="col-span-2 mt-1">
                      <span style={{ color: 'var(--text-muted)' }}>{t('livefeed.detail', 'Detail:')} </span>
                      <p
                        className="mt-0.5 p-2 rounded text-xs whitespace-pre-wrap"
                        style={{
                          background: 'var(--bg-secondary)',
                          color: copied === detailCopyText ? 'var(--success)' : 'var(--text-secondary)',
                          border: '1px solid var(--border)',
                          cursor: 'pointer',
                        }}
                        onClick={(e) => { e.stopPropagation(); handleCopy(detailCopyText); }}
                        onMouseEnter={hasRawDetail ? (e) => { e.stopPropagation(); showTip(rawDetail, e); } : undefined}
                        onMouseMove={hasRawDetail ? moveTip : undefined}
                        onMouseLeave={hasRawDetail ? hideTip : undefined}
                        title={hasRawDetail ? undefined : t('livefeed.clickToCopy', 'Click to copy')}
                      >{safeDetail}</p>
                    </div>
                  )}

                  {exposeId && (
                    <div className="col-span-2">
                      <button
                        className="btn btn-ghost text-xs"
                        style={{ color: supportBusyId === exposeId ? 'var(--success)' : 'var(--accent)', padding: '3px 8px' }}
                        onClick={(e) => { e.stopPropagation(); if (supportBusyId !== exposeId) handleSupportBundle(item, exposeId); }}
                        disabled={supportBusyId === exposeId}
                      >
                        {supportBusyId === exposeId ? t('livefeed.supportExported', '✓ Debug bundle exported') : t('livefeed.supportExport', '📦 Export Debug Bundle')}
                      </button>
                      <span className="ml-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                        {t('livefeed.supportDesc', 'screenshot + HTML + entry logs')}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}

      {/* Badge tooltip — instant hover, same pattern as image preview */}
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
