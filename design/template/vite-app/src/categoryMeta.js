const categoryMeta = {
  "Meat + Poultry": {
    icon: "M",
    note: "Pasture raised cuts",
    image:
      "https://images.unsplash.com/photo-1604908176997-125f25cc6f3d?auto=format&fit=crop&w=900&q=80"
  },
  Dairy: {
    icon: "D",
    note: "Milk, butter, cheese",
    image:
      "https://storage.googleapis.com/grazecart-images-prod/images/d6b30a59-7d14-4c92-b807-f37c569361f4.jpg"
  },
  Eggs: {
    icon: "E",
    note: "Weekly farm eggs",
    image:
      "https://images.unsplash.com/photo-1506976785307-8732e854ad03?auto=format&fit=crop&w=900&q=80"
  },
  Pantry: {
    icon: "P",
    note: "Grains, honey, herbs",
    image:
      "https://images.unsplash.com/photo-1505576399279-565b52d4ac71?auto=format&fit=crop&w=900&q=80"
  }
};

export function getCategoryMeta(name) {
  return categoryMeta[name] || {
    icon: name?.[0] || "C",
    note: "",
    image: ""
  };
}
