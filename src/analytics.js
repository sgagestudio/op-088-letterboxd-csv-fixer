export const ALLOWED_EVENTS = new Set([
  'landing_view','tool_started','input_loaded','analysis_started','analysis_completed',
  'successful_result','warning_result','unsupported_result','download','error',
  'pricing_view','checkout_started','purchase'
]);

const SAFE_KEYS = new Set([
  'product_id','experiment_id','event_version','status_code','warning_count','error_code',
  'elapsed_bucket','input_size_bucket','result_count_bucket','download_clicked','row_count_bucket',
  'ambiguous_count','data_loss_flag','source_type'
]);

const DB_KEYS = new Set([
  'source_type','input_size_bucket','status_code','warning_count','row_count_bucket',
  'ambiguous_count','data_loss_flag','elapsed_bucket','download_clicked','error_code'
]);

export const SUPABASE_ANALYTICS = Object.freeze({
  url: 'https://tiqhrgwibjvcbjxhutba.supabase.co',
  publishableKey: 'sb_publishable_QlzGLnUevNmTDB0HwUGmRA_Yx7cA4VS'
});

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

function safeUuid(uuid = () => globalThis.crypto?.randomUUID?.()) {
  return uuid?.() || '00000000-0000-4000-8000-000000000000';
}

export function createSupabaseTransport({
  fetcher = globalThis.fetch?.bind(globalThis),
  endpoint = SUPABASE_ANALYTICS.url,
  publishableKey = SUPABASE_ANALYTICS.publishableKey
} = {}) {
  if (!fetcher) return null;
  return async (event) => {
    const body = {
      client_ts: event.ts,
      session_id: event.session_id,
      product_id: 'OP-088',
      event_version: 1,
      event_name: event.name
    };
    for (const [key, value] of Object.entries(event.properties || {})) {
      if (DB_KEYS.has(key)) body[key] = value;
    }
    const response = await fetcher(`${endpoint}/rest/v1/market_events`, {
      method: 'POST',
      headers: {
        apikey: publishableKey,
        'content-type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(body),
      keepalive: true
    });
    if (!response.ok) throw new Error(`analytics_transport_http_${response.status}`);
    return true;
  };
}

export function createAnalytics({
  now = () => new Date().toISOString(),
  uuid = () => globalThis.crypto?.randomUUID?.(),
  transport = null
} = {}) {
  const events = [];
  const sessionId = safeUuid(uuid);

  function track(name, properties = {}) {
    if (!ALLOWED_EVENTS.has(name)) throw new Error(`analytics_event_not_allowed:${name}`);
    const event = {
      name,
      ts: now(),
      session_id: sessionId,
      properties: sanitizeProperties({ product_id: 'OP-088', event_version: 1, ...properties })
    };
    events.push(event);
    globalThis.dispatchEvent?.(new CustomEvent('op088:analytics', { detail: event }));
    if (transport) Promise.resolve(transport(event)).catch(() => {});
    return event;
  }

  function markLanding() {
    track('landing_view');
  }

  return { track, markLanding, events, sessionId };
}

export const analytics = createAnalytics({ transport: createSupabaseTransport() });
