const { normalizePayPalStatus, paypalRequest, supabaseRequest } = require('./paypal');

async function subscriptionAlreadyClaimed(subscriptionId) {
  const response = await supabaseRequest(`establishments?paypal_subscription_id=eq.${encodeURIComponent(subscriptionId)}&select=id&limit=1`);
  if (!response || !response.ok) return false;
  const rows = await response.json();
  return Array.isArray(rows) && rows.length > 0;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const subscriptionId = req.query.subscription_id;
  if (!subscriptionId) return res.status(400).json({ error: 'Missing PayPal subscription.' });

  try {
    if (await subscriptionAlreadyClaimed(subscriptionId)) {
      return res.status(409).json({ error: 'This PayPal subscription has already created an owner workspace.' });
    }

    const subscription = await paypalRequest(`/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`);
    const status = normalizePayPalStatus(subscription.status);
    if (status !== 'active') {
      return res.status(402).json({ error: 'PayPal subscription is not active yet. Wait a moment, then refresh.' });
    }

    return res.status(200).json({
      ok: true,
      provider: 'paypal',
      subscription_id: subscription.id,
      subscription_status: status,
      paypal_status: subscription.status,
      plan_id: subscription.plan_id || '',
      payer_id: subscription.subscriber?.payer_id || '',
      email: subscription.subscriber?.email_address || '',
      current_period_end: subscription.billing_info?.next_billing_time || null
    });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Could not verify PayPal subscription.' });
  }
};
