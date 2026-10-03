import { isSourcePricingVendor } from './productPricing.js';
import { turkeyBreed } from './storefrontDescriptions.js';

// Retail prices are the local Products retail column, without CSA factors or markups.
// Preorder checkout sells whole birds. Never interpret a per-pound value as a bird price.
export function storefrontRetailPrice(product, packages = []) {
  let amount;
  if (isSourcePricingVendor({ name: product.vendor })) {
    if (!['each', 'ea'].includes(String(product.unit_of_measure || '').toLowerCase())) {
      return { retailPriceCents: null, priceError: 'Set Retail Price per each in Products for this turkey.' };
    }
    amount = product.source_unit_price;
  } else {
    const offered = packages.filter(pkg => pkg.visible == null || Boolean(pkg.visible));
    if (offered.length !== 1 || Number(offered[0].num_of_items || 1) !== 1 ||
      (offered[0].charge_type !== 'package' && !['each','ea'].includes(String(offered[0].unit || '').toLowerCase()))) {
      return { retailPriceCents: null, priceError: 'Choose a product with one package priced per turkey in Products.' };
    }
    amount = offered[0].price;
  }
  const cents = amount == null || amount === '' ? NaN : Math.round(Number(amount) * 100);
  if (!Number.isSafeInteger(cents) || cents < 50 || cents > 10000000) return { retailPriceCents: null, priceError: 'Set a valid Retail Price in Products before offering this turkey.' };
  return { retailPriceCents: cents, priceError: '' };
}

// Read catalog identity, descriptions, retail prices, and photos. Never read or write catalog inventory.
export async function readStorefrontProducts(connection) {
  const [products] = await connection.query(`SELECT p.id,p.name,p.description,p.thumbnail_url,c.name AS category,v.name AS vendor,
      pp.source_unit_price,pp.unit_of_measure
    FROM products p LEFT JOIN categories c ON c.id=p.category_id
    JOIN vendors v ON v.id=p.vendor_id AND TRIM(v.name) <> ''
    LEFT JOIN product_pricing_profiles pp ON pp.product_id=p.id
    WHERE COALESCE(p.is_deleted,0)=0 AND LOWER(COALESCE(c.name,'')) <> 'membership'
      AND (LOWER(p.name) LIKE '%turkey%' OR LOWER(c.name) LIKE '%turkey%') ORDER BY p.name,p.id`);
  if (!products.length) return [];
  const ids = products.map(product => product.id);
  const [[images], [packages]] = await Promise.all([
    connection.query('SELECT product_id,url FROM product_images WHERE product_id IN (?) ORDER BY id', [ids]),
    connection.query('SELECT product_id,name,price,visible,num_of_items,charge_type,unit FROM packages WHERE product_id IN (?) ORDER BY id', [ids])
  ]);
  return products.map(product => {
    const productPackages = packages.filter(pack => pack.product_id === product.id);
    const photos = [...new Set(images.filter(image => image.product_id === product.id).map(image => image.url).filter(Boolean))];
    if (!photos.length && product.thumbnail_url) photos.push(product.thumbnail_url);
    return { id: product.id, name: product.name, vendor: product.vendor, category: product.category,
      description: product.description || '', preorderBreed: turkeyBreed(product.name), imageUrl: photos[0] || '', images: photos,
      ...storefrontRetailPrice(product, productPackages),
      sizeDescription: [...new Set(productPackages.map(pack => pack.name).filter(Boolean))].join(' / '),
      wholeTurkey: /thanksgiving.*turkey/i.test(product.category || '') || /(?:heritage|broad breasted).*turkey/i.test(product.name)
    };
  });
}
