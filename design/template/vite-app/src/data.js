export const brand = "Full Farm CSA at Deck Family Farm";

export const hero = {
  eyebrow: "Market to table",
  title: "Promoting nutritional wellness",
  body:
    "Build your share from pasture-raised meats, dairy, and pantry staples. Use monthly credits, roll them forward, and top up only when you want.",
  primary: "Shop this cycle",
  secondary: "View CSA plans",
  image:
    "https://lh3.googleusercontent.com/p/AF1QipNMODIkc-VoelsdNINmQb69xyUk61IFel5rzFAx=s1400-w1400-h1050-rw",
};

export const plans = [
  {
    price: "$300",
    title: "Most popular",
    note: "Great for weekly staples + a few extras",
    featured: true,
  },
  {
    price: "$200",
    title: "Small household",
    note: "Flexible for lighter weeks",
    featured: false,
  },
  {
    price: "$500",
    title: "Big table",
    note: "Best for bulk + freezer stock",
    featured: false,
  },
];

export const csaPlanTiles = [
  {
    price: "$200",
    title: "Good for small households",
    note: "$5 herdshare + $5 dividend posted monthly",
    featured: false,
  },
  {
    price: "$300",
    title: "Most popular",
    note: "Ideal for weekly pantry and protein",
    featured: true,
  },
  {
    price: "$500",
    title: "Feeding a crew",
    note: "For large families or bulk orders",
    featured: false,
  },
];

export const seasonalHighlights = [
  {
    eyebrow: "Seasonal",
    title: "Winter broth and roast bundle.",
    body:
      "Save on grass-fed beef bones, marrow, and stew cuts. Perfect for slow weekends and freezer stocking.",
    cta: "Add bundle",
  },
  {
    eyebrow: "From the dairy",
    title: "Farmstead cheese flight.",
    body:
      "Three small batch cheeses with pairing notes and a pantry list for simple boards.",
    cta: "View details",
  },
];

export const herdshare = {
  title: "Herdshare + credits",
  body:
    "$5 herdshare fee is paired with a $5 dividend credit each month for audit clarity. Credits roll over forever and can be donated to Feed-a-Friend when you leave.",
};

export const delivery = {
  eyebrow: "Delivery and pickup",
  title: "Choose a drop site or check zone eligibility.",
  body:
    "We deliver across the valley with order windows based on drop day. Pickups stay free for members, delivery is available for a small fee.",
  routes: [
    { title: "Tuesday route", note: "Order Fri to Sun" },
    { title: "Saturday route", note: "Order Mon to Wed" },
  ],
  mapImage:
    "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=1200&q=80",
};

export const dropSite = {
  defaultSite: "Elm St Church",
  options: ["Elm St Church", "River Market", "Southtown Depot"],
};

export const productDetail = {
  eyebrow: "Featured cut",
  title: "Grass-fed Ribeye Steak",
  body:
    "Dry-aged in small batches for a deep, buttery finish. Each cut is hand trimmed and vacuum sealed. Jar return credit available at pickup.",
  price: "$24.00",
  note: "1 lb average - Member pricing available",
  gallery: [
    {
      image:
        "https://images.unsplash.com/photo-1544025162-d76694265947?auto=format&fit=crop&w=1000&q=80",
      alt: "Ribeye steak on a cutting board",
    },
    {
      image:
        "https://images.unsplash.com/photo-1490645935967-10de6ba17061?auto=format&fit=crop&w=900&q=80",
      alt: "Seasonal garnish and herbs",
    },
    {
      image:
        "https://images.unsplash.com/photo-1504674900247-0877df9cc836?auto=format&fit=crop&w=900&q=80",
      alt: "Cooked steak with sides",
    },
  ],
  reviews: [
    { rating: "*****", quote: "Best sear all winter.", author: "Morgan", date: "Dec 14" },
    { rating: "****", quote: "Great marbling, cooked fast.", author: "Jamie", date: "Dec 2" },
  ],
};


export const accountPanel = {
  title: "Member settings",
  body:
    "Manage your default drop site, delivery notes, and monthly plan in one place.",
};
