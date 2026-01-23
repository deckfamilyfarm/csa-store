export const brand = "Full Farm CSA at Deck Family Farm";

export const navLinks = [
  { href: "#shop", label: "Shop" },
  { href: "#csa", label: "CSA Plans" },
  { href: "#plan-chooser", label: "Choose a Plan" },
  { href: "#recipes", label: "Recipes" },
  { href: "#delivery", label: "Delivery" },
  { href: "#product-detail", label: "Product" },
  { href: "#account", label: "Account" },
  { href: "#cart", label: "Cart (3)" },
];

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

export const categories = [
  {
    icon: "All",
    title: "Show all",
    note: "Every category",
    key: "all",
    image:
      "https://images.unsplash.com/photo-1504754524776-8f4f37790ca0?auto=format&fit=crop&w=900&q=80",
  },
  {
    icon: "M",
    title: "Meat + Poultry",
    note: "Pasture raised cuts",
    key: "meat",
    image:
      "https://images.unsplash.com/photo-1604908176997-125f25cc6f3d?auto=format&fit=crop&w=900&q=80",
  },
  {
    icon: "D",
    title: "Dairy",
    note: "Milk, butter, cheese",
    key: "dairy",
    image:
      "https://storage.googleapis.com/grazecart-images-prod/images/d6b30a59-7d14-4c92-b807-f37c569361f4.jpg",
  },
  {
    icon: "E",
    title: "Eggs",
    note: "Weekly farm eggs",
    key: "eggs",
    image:
      "https://images.unsplash.com/photo-1506976785307-8732e854ad03?auto=format&fit=crop&w=900&q=80",
  },
  {
    icon: "P",
    title: "Pantry",
    note: "Grains, honey, herbs",
    key: "pantry",
    image:
      "https://images.unsplash.com/photo-1505576399279-565b52d4ac71?auto=format&fit=crop&w=900&q=80",
  },
];

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

export const products = [
  {
    name: "Ribeye Steak",
    note: "1 lb average",
    price: "$24.00",
    category: "meat",
    featured: true,
    rating: 5,
    description:
      "Dry-aged in small batches for a deep, buttery finish. Hand-trimmed and vacuum sealed.",
    reviews: [
      { rating: "*****", quote: "Best sear all winter.", author: "Morgan" },
      { rating: "****", quote: "Great marbling, cooked fast.", author: "Jamie" },
    ],
    image:
      "https://images.unsplash.com/photo-1558030006-450675393462?auto=format&fit=crop&w=900&q=80",
  },
  {
    name: "Raw Milk, 1/2 gal",
    note: "Jar deposit included",
    price: "$10.00",
    category: "dairy",
    featured: true,
    rating: 4,
    description:
      "Rich, creamy raw milk from pasture-raised cows. Bring your jar for return credit.",
    reviews: [
      { rating: "*****", quote: "So fresh and clean tasting.", author: "Taylor" },
      { rating: "****", quote: "Perfect for yogurt.", author: "Casey" },
    ],
    image:
      "https://storage.googleapis.com/grazecart-images-prod/images/d6b30a59-7d14-4c92-b807-f37c569361f4.jpg",
  },
  {
    name: "Pastured Eggs",
    note: "Dozen",
    price: "$8.00",
    category: "eggs",
    featured: true,
    rating: 5,
    description:
      "Golden yolks, collected weekly from hens on rotating pasture.",
    reviews: [
      { rating: "*****", quote: "Deep color and flavor.", author: "Riley" },
      { rating: "****", quote: "Best for baking.", author: "Jordan" },
    ],
    image:
      "https://images.unsplash.com/photo-1518569656558-1f25e69d93d7?auto=format&fit=crop&w=900&q=80",
  },
  {
    name: "Heirloom Beans",
    note: "2 lb bag",
    price: "$12.00",
    category: "pantry",
    featured: false,
    rating: 4,
    description:
      "Slow-simmered comfort beans with a nutty finish. Great for soups and stews.",
    reviews: [
      { rating: "*****", quote: "Creamy texture every time.", author: "Avery" },
      { rating: "****", quote: "Holds shape well.", author: "Sam" },
    ],
    image:
      "https://images.unsplash.com/photo-1506806732259-39c2d0268443?auto=format&fit=crop&w=900&q=80",
  },
  {
    name: "Whole Chicken",
    note: "3-4 lb average",
    price: "$18.00",
    category: "meat",
    featured: false,
    rating: 5,
    description:
      "Pasture-raised birds with rich flavor. Great for roast + stock.",
    reviews: [
      { rating: "*****", quote: "Juicy and tender.", author: "Kendall" },
      { rating: "****", quote: "Makes a great broth.", author: "Parker" },
    ],
    image:
      "https://images.unsplash.com/photo-1604908176997-125f25cc6f3d?auto=format&fit=crop&w=900&q=80",
  },
  {
    name: "Ground Beef",
    note: "1 lb pack",
    price: "$9.50",
    category: "meat",
    featured: false,
    rating: 4,
    description:
      "80/20 grind from grass-fed cattle. Ideal for weeknight meals.",
    reviews: [
      { rating: "*****", quote: "Burgers hold together well.", author: "Emerson" },
      { rating: "****", quote: "Great flavor.", author: "Quinn" },
    ],
    image:
      "https://images.unsplash.com/photo-1544025162-d76694265947?auto=format&fit=crop&w=900&q=80",
  },
  {
    name: "Farm Butter",
    note: "8 oz",
    price: "$6.00",
    category: "dairy",
    featured: false,
    rating: 3,
    description:
      "Small-batch butter churned weekly. Clean, sweet cream finish.",
    reviews: [
      { rating: "*****", quote: "Perfect on toast.", author: "Drew" },
      { rating: "****", quote: "Melts beautifully.", author: "Hayden" },
    ],
    image:
      "https://images.unsplash.com/photo-1481391032119-d89fee407e44?auto=format&fit=crop&w=900&q=80",
  },
  {
    name: "Sourdough Loaf",
    note: "Baked weekly",
    price: "$7.00",
    category: "pantry",
    featured: true,
    rating: 5,
    description:
      "Slow-fermented loaf with a crisp crust and chewy crumb.",
    reviews: [],
    image:
      "https://images.unsplash.com/photo-1549931319-a545dcf3bc73?auto=format&fit=crop&w=900&q=80",
  },
  {
    name: "Seasonal Veg Box",
    note: "Rotating produce",
    price: "$28.00",
    category: "pantry",
    featured: false,
    rating: 4,
    description:
      "A mix of field-fresh produce with weekly rotation and recipe ideas.",
    reviews: [
      { rating: "*****", quote: "So much variety.", author: "Sasha" },
      { rating: "****", quote: "Fresh and crisp.", author: "Jules" },
    ],
    image:
      "https://images.unsplash.com/photo-1464226184884-fa280b87c399?auto=format&fit=crop&w=900&q=80",
  },
  {
    name: "Honey Jar",
    note: "12 oz",
    price: "$11.00",
    category: "pantry",
    featured: false,
    rating: 4,
    description:
      "Raw wildflower honey with a floral finish. Local and unfiltered.",
    reviews: [],
    image:
      "https://images.unsplash.com/photo-1471943038886-87c772d091f0?auto=format&fit=crop&w=900&q=80",
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

export const recipes = [
  {
    title: "Sunday pot roast",
    note: "How to braise with marrow bones and roots.",
    image:
      "https://images.unsplash.com/photo-1504674900247-0877df9cc836?auto=format&fit=crop&w=900&q=80",
    ingredients: [
      "2.5 lb beef roast",
      "2 tbsp oil",
      "1 onion, sliced",
      "3 carrots, chopped",
      "2 cups broth",
      "1 tbsp tomato paste",
      "Salt and pepper",
    ],
    steps: [
      "Season roast with salt and pepper.",
      "Sear in a heavy pot until browned on all sides.",
      "Add onion and carrots; cook 5 minutes.",
      "Stir in tomato paste, then add broth.",
      "Cover and braise at 325F for 2.5 hours.",
    ],
  },
  {
    title: "Weeknight skillet eggs",
    note: "Pantry staples you already have.",
    image:
      "https://static01.nyt.com/images/2024/03/20/multimedia/20APPErex-whlf/27APPErex-whlf-jumbo.jpg?quality=75&auto=webp",
    ingredients: [
      "2 tbsp butter",
      "4 eggs",
      "1 cup spinach",
      "1/2 cup cherry tomatoes",
      "Salt and pepper",
    ],
    steps: [
      "Melt butter in a skillet over medium heat.",
      "Add spinach and tomatoes; cook until wilted.",
      "Crack eggs into the pan and cover for 3-4 minutes.",
      "Season and serve with toast.",
    ],
  },
  {
    title: "Raw milk yogurt",
    note: "Simple cultures, low heat, big flavor.",
    image:
      "https://www.preciouscore.com/wp-content/uploads/2018/08/homemade-yogurt-tips.jpg",
    ingredients: [
      "4 cups raw milk",
      "2 tbsp live-culture yogurt",
      "Clean jar",
    ],
    steps: [
      "Warm milk to 110F, then remove from heat.",
      "Stir in live-culture yogurt.",
      "Cover and keep warm 8-12 hours.",
      "Chill for 4 hours before serving.",
    ],
  },
];

export const accountPanel = {
  title: "Member settings",
  body:
    "Manage your default drop site, delivery notes, and monthly plan in one place.",
};
