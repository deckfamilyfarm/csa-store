// Called only after the shared storefront endpoint verifies Stripe's raw-body
// signature. Keep service construction lazy so merchandise setup cannot affect
// turkey checkout or its webhook processing.
export async function dispatchStorefrontStripeEvent(event, { pool, storefront, merchandise }) {
  const object = event.data?.object;
  const metadata = object?.metadata || {};
  if (metadata.commerce_order_id && metadata.storefront_order_id) {
    throw Object.assign(new Error('Stripe event has conflicting order ownership.'), { status: 409 });
  }
  let isMerchandise = Boolean(metadata.commerce_order_id);
  if (!isMerchandise && !metadata.storefront_order_id &&
      ['refund.created', 'refund.updated', 'refund.failed', 'charge.refunded'].includes(event.type)) {
    // Refund/charge metadata need not contain our order ID. Resolve the stored
    // payment receipt; order numbers in the two systems can overlap.
    const paymentId = typeof object?.payment_intent === 'string' ? object.payment_intent : object?.payment_intent?.id;
    if (paymentId) {
      const owns = async table => {
        try {
          const [rows] = await pool.query(`SELECT id FROM ${table} WHERE stripe_payment_id=? LIMIT 1`, [paymentId]);
          return rows.length > 0;
        } catch (error) {
          // Merchandise is an optional explicit migration. Never create tables
          // here, or require them to process existing turkey payments.
          if (error.code === 'ER_NO_SUCH_TABLE') return false;
          throw error;
        }
      };
      if (!await owns('storefront_orders')) isMerchandise = await owns('commerce_orders');
    }
  }
  const service = isMerchandise ? merchandise() : storefront();
  const result = await (isMerchandise ? service.stripeWebhook(event) : service.webhook(event));
  return { service, result };
}
