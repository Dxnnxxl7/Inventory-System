const { normalizePayPalStatus, paypalRequest, supabaseRequest } = require('./paypal');

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function verifyWebhook(req, event) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) return false;
  const verification = await paypalRequest('/v1/notifications/verify-webhook-signature', {
    method: 'POST',
    body: JSON.stringify({
      auth_algo: req.headers['paypal-auth-algo'],
      cert_url: req.headers['paypal-cert-url'],
      transmission_id: req.headers['paypal-transmission-id'],
      transmission_sig: req.headers['paypal-transmission-sig'],
      transmission_time: req.headers['paypal-transmission-time'],
      webhook_id: webhookId,
      webhook_event: event
    })
  });
  return verification.verification_status === 'SUCCESS';
}

async function logEvent(event) {
  try {
    const resource = event.resource || {};
    await supabaseRequest('billing_events', {
      method: 'POST',
      body: JSON.stringify({
        payment_provider: 'paypal',
        paypal_event_id: event.id,
        event_type: event.event_type,
        paypal_subscription_id: resource.id || resource.billing_agreement_id || null,
        payload: event
      })
    });
  } catch (_) {}
}

async function updateBySubscriptionId(subscriptionId, status, extra = {}) {
  if (!subscriptionId) return;
  await supabaseRequest(`establishments?paypal_subscription_id=eq.${encodeURIComponent(subscriptionId)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      subscription_status: status,
      billing_updated_at: new Date().toISOString(),
      ...extra
    })
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('Method not allowed');
  }

  const raw = await readRawBody(req);
  let event;
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch (_) {
    return res.status(400).send('Invalid webhook body');
  }

  try {
    const verified = await verifyWebhook(req, event);
    if (!verified) return res.status(400).send('Webhook signature failed');
  } catch (error) {
    return res.status(400).send(`Webhook signature failed: ${error.message}`);
  }

  await logEvent(event);

  const resource = event.resource || {};
  const subscriptionId = resource.id || resource.billing_agreement_id || resource.subscription_id;
  if (event.event_type && event.event_type.startsWith('BILLING.SUBSCRIPTION.')) {
    const normalized = normalizePayPalStatus(resource.status);
    await updateBySubscriptionId(subscriptionId, normalized, {
      current_period_end: resource.billing_info?.next_billing_time || null,
      paypal_plan_id: resource.plan_id || null,
      paypal_payer_id: resource.subscriber?.payer_id || null
    });
  }

  if (event.event_type === 'PAYMENT.SALE.COMPLETED' || event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
    await updateBySubscriptionId(subscriptionId, 'active');
  }

  if (event.event_type === 'BILLING.SUBSCRIPTION.PAYMENT.FAILED') {
    await updateBySubscriptionId(subscriptionId, 'past_due');
  }

  return res.status(200).json({ received: true });
};

module.exports.config = {
  api: {
    bodyParser: false
  }
};
