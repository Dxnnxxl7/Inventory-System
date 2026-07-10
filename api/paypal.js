function paypalBaseUrl() {
  return process.env.PAYPAL_MODE === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}

async function paypalAccessToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !secret) throw new Error('PayPal is not configured yet.');

  const response = await fetch(`${paypalBaseUrl()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.message || 'Could not connect to PayPal.');
  }
  return data.access_token;
}

async function paypalRequest(path, options = {}) {
  const token = await paypalAccessToken();
  const response = await fetch(`${paypalBaseUrl()}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'content-type': 'application/json',
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const details = Array.isArray(data.details)
      ? data.details.map(item => item.description || item.issue).filter(Boolean).join(' ')
      : '';
    const message = details || data.message || data.error_description || data.name || 'PayPal request failed.';
    throw new Error(message);
  }
  return data;
}

function appUrl(req) {
  return (process.env.APP_URL || req.headers.origin || '').replace(/\/$/, '');
}

function normalizePayPalStatus(status) {
  const value = String(status || '').toUpperCase();
  if (value === 'ACTIVE') return 'active';
  if (value === 'SUSPENDED') return 'past_due';
  if (value === 'CANCELLED') return 'canceled';
  if (value === 'EXPIRED') return 'incomplete_expired';
  if (value === 'APPROVAL_PENDING' || value === 'APPROVED') return 'incomplete';
  return 'incomplete';
}

async function supabaseRequest(path, options = {}) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return fetch(`${url.replace(/\/$/, '')}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      prefer: 'resolution=merge-duplicates',
      ...(options.headers || {})
    }
  });
}

module.exports = {
  appUrl,
  normalizePayPalStatus,
  paypalBaseUrl,
