export function merchandiseOptionGroups(variants) {
  const first = variants[0]?.options;
  if (!first?.length || variants.length < 2) return [];

  const types = first.map(option => option.type);
  if (types.some(type => typeof type !== 'string' || !type.trim()) || new Set(types).size !== types.length) return [];
  const values = new Map(types.map(type => [type, new Map()]));
  const combinations = new Set();
  for (const variant of variants) {
    if (variant.options?.length !== types.length) return [];
    const tuple = [];
    for (const type of types) {
      const option = variant.options.find(candidate => candidate.type === type);
      if (option?.id == null || typeof option.title !== 'string' || !option.title.trim()) return [];
      const id = String(option.id);
      const existing = values.get(type).get(id);
      if (existing && existing !== option.title) return [];
      values.get(type).set(id, option.title);
      tuple.push(id);
    }
    const key = JSON.stringify(tuple);
    if (combinations.has(key)) return [];
    combinations.add(key);
  }
  return types.map(type => ({ type, values: [...values.get(type)].map(([id, title]) => ({ id, title })) }));
}

export function merchandiseVariantForOptions(variants, options) {
  return variants.find(variant => Object.entries(options).every(([type, id]) =>
    variant.options?.some(option => option.type === type && String(option.id) === id)));
}
