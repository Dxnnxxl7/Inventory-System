const { appUrl, paypalRequest } = require('./paypal');

async function createStarterPlan(req) {
  const amount = process.env.PAYPAL_PRICE_STARTER || '29.00';
  const currency = process.env.PAYPAL_CURRENCY || 'AUD';
  const product = await paypalRequest('/v1/catalogs/products', {
    method: 'POST',
    headers: {
      prefer: 'return=representation',
      'PayPal-Request-Id': `stored-product-${currency}-${amount}`
    },
    body: JSON.stringify({
      name: 'Inventory Tracking System',
      description: 'Inventory tracking subscription',
      type: 'SERVICE',
      category: 'COMPUTER_AND_DATA_PROCESSING_SERVICES'
    })
  });

  const plan = await paypalRequest('/v1/billing/plans', {
    method: 'POST',
    headers: {
      prefer: 'return=representation',
      'PayPal-Request-Id': `stored-plan-${currency}-${amount}`
    },
    body: JSON.stringify({
      product_id: product.id,
      name: 'Monthly Subscription',
      description: 'Monthly access to Inventory Tracking System',
      status: 'ACTIVE',
      billing_cycles: [
        {
          frequency: { interval_unit: 'MONTH', interval_count: 1 },
          tenure_type: 'REGULAR',
          sequence: 1,
          total_cycles: 0,
          pricing_scheme: {
            fixed_price: { value: amount, currency_code: currency }
          }
        }
      ],
      payment_preferences: {
        auto_bill_outstanding: true,
        setup_fee_failure_action: 'CONTINUE',
        payment_failure_threshold: 3
      }
    })
  });

  return plan.id;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const url = appUrl(req);
  if (!url) return res.status(500).json({ error: 'APP_URL is not configured yet.' });

  try {
    const planId = process.env.PAYPAL_PLAN_ID_STARTER || await createStarterPlan(req);
    const subscription = await paypalRequest('/v1/billing/subscriptions', {
      method: 'POST',
      headers: {
        prefer: 'return=representation',
        'PayPal-Request-Id': `stored-sub-${Date.now()}`
      },
      body: JSON.stringify({
        plan_id: planId,
        application_context: {
          brand_name: 'Inventory Tracking System',
          locale: 'en-AU',
          shipping_preference: 'NO_SHIPPING',
          user_action: 'SUBSCRIBE_NOW',
          return_url: `${url}/?owner_signup=1`,
          cancel_url: `${url}/#landing`
        }
      })
    });

    const approval = (subscription.links || []).find(link => link.rel === 'approve');
    if (!approval?.href) return res.status(500).json({ error: 'PayPal did not return an approval link.' });
    return res.status(200).json({ url: approval.href, subscription_id: subscription.id, plan_id: planId });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Could not start PayPal subscription.' });
  }
};
