import { fail, verifyPrintifySignature } from './merchandiseCore.js';
export { verifyPrintifySignature };
export function createPrintify({ token = '', fetchImpl = globalThis.fetch, config = {} } = {}) {
  async function request(endpoint, body) {
    if (!token) fail('Printify token is not configured.', 503);
    if (!/^[a-zA-Z0-9_/?=&.\-]+$/.test(endpoint) || endpoint.includes('..') || endpoint.startsWith('/')) fail('Invalid Printify endpoint.');
    let response;
    try {
      response = await fetchImpl(`https://api.printify.com/v1/${endpoint}`, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(45000),
        headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'CSAStore-Merchandise/1.0', 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
    } catch { throw Object.assign(new Error('Printify request outcome is unknown; reconcile before retry.'), { unknown: true }); }
    let data; try { data = await response.json(); } catch { throw Object.assign(new Error('Printify returned an unreadable receipt; reconcile before retry.'), { unknown: true }); }
    if (!response.ok) throw Object.assign(new Error(`Printify returned HTTP ${response.status}.`), {
      providerStatus: response.status, definitive: [400,401,403,404,422,429].includes(response.status),
      existingOrderId: response.status === 409 ? data.order?.id : null
    });
    return data;
  }
  const id = value => { const string=String(value); if (!/^[a-zA-Z0-9-]{1,100}$/.test(string)) fail('Invalid supplier ID.'); return string; };
  async function optional(endpoint) { try { return await request(endpoint); } catch(error) { if ([404,403].includes(error.providerStatus)) return null; throw error; } }
  function allowOrder(shopId) {
    if (!config.ordersEnabled || !config.manualApprovalVerified || String(config.approvedShopId) !== String(shopId)) fail('Printify order creation is disabled or manual approval has not been verified for this shop.', 409);
  }
  return {
    key: 'printify', supportsTestOrders: false,
    shops: () => request('shops.json'),
    product: (shop, product) => request(`shops/${id(shop)}/products/${id(product)}.json`),
    async metadata(product) {
      const endpoint = `catalog/blueprints/${id(product.blueprint_id)}/print_providers/${id(product.print_provider_id)}`;
      const provider = await optional(`catalog/print_providers/${id(product.print_provider_id)}.json`);
      const variants = await optional(`${endpoint}/variants.json?show-out-of-stock=1`);
      const shipping = await optional(`${endpoint}/shipping.json`);
      const artworkIds = [...new Set((product.print_areas || []).flatMap(area => (area.placeholders || []).flatMap(h => (h.images || []).map(i => i.id).filter(Boolean))))];
      const unresolvedArtwork = [];
      for (const artwork of artworkIds) if (!await optional(`uploads/${id(artwork)}.json`)) unresolvedArtwork.push(artwork);
      return { provider, variants, shipping, unresolvedArtwork };
    },
    quoteShipping: (shop, body) => request(`shops/${id(shop)}/orders/shipping.json`, body),
    order: (shop, order) => request(`shops/${id(shop)}/orders/${id(order)}.json`),
    async findOrder(shop, externalId) {
      for (let page=1; page<=1000; page++) {
        const result = await request(`shops/${id(shop)}/orders.json?limit=50&page=${page}`);
        const found = result.data?.filter(order => order.metadata?.shop_order_id === externalId) || [];
        if (found.length > 1) fail('Multiple supplier orders match this operation; review required.',409);
        if (found.length) return this.order(shop,found[0].id);
        if (!Array.isArray(result.data)) fail('Unable to reconcile supplier orders.',503);
        if (result.current_page >= result.last_page || result.next_page_url === null || result.data.length < 50) return null;
      }
      fail('Supplier order reconciliation is incomplete.',409);
    },
    createOrder(shop, body) { allowOrder(shop); return request(`shops/${id(shop)}/orders.json`, body); },
    cancelOrder(shop, order) { allowOrder(shop); return request(`shops/${id(shop)}/orders/${id(order)}/cancel.json`, {}); },
    sendToProduction(shop, order) {
      allowOrder(shop);
      if (!config.productionEnabled) fail('Printify production submission is disabled.',409);
      return request(`shops/${id(shop)}/orders/${id(order)}/send_to_production.json`, {});
    }
  };
}
