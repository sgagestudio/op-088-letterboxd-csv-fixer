export const ALLOWED_EVENTS = new Set([
  'landing_view','tool_started','input_loaded','analysis_started','analysis_completed',
  'successful_result','warning_result','unsupported_result','download','error','return_visit',
  'pricing_view','checkout_started','purchase'
]);

const SAFE_KEYS = new Set([
  'product_id','experiment_id','event_version','status_code','warning_count','error_code',
  'elapsed_bucket','input_size_bucket','result_count_bucket','download_clicked','row_count_bucket',
  'ambiguous_count','data_loss_flag','source_type'
]);

export function sanitizeProperties(input = {}) {
  const out = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (!SAFE_KEYS.has(key)) continue;
    if (['string','number','boolean'].includes(typeof value) || value == null) out[key] = value;
  }
  return out;
}

export function sizeBucket(length = 0) {
  if (length <= 0) return 'empty';
  if (length < 1000) return 'lt_1k';
  if (length < 10000) return '1k_10k';
  if (length < 100000) return '10k_100k';
  return 'gte_100k';
}

export function createAnalytics({ storage = globalThis.localStorage, now = () => new Date().toISOString() } = {}) {
  const events = [];
  function track(name, properties = {}) {
    if (!ALLOWED_EVENTS.has(name)) throw new Error(`analytics_event_not_allowed:${name}`);
    const event = {
      name,
      ts: now(),
      properties: sanitizeProperties({ product_id: 'OP-088', event_version: 1, ...properties })
    };
    events.push(event);
    globalThis.dispatchEvent?.(new CustomEvent('op088:analytics', { detail: event }));
    return event;
  }
  function markLanding() {
    track('landing_view');
    try {
      const key = 'op088_seen_private_landing';
      if (storage?.getItem(key)) track('return_visit');
      else storage?.setItem(key, '1');
    } catch {}
  }
  return { track, markLanding, events };
}

export const analytics = createAnalytics();
