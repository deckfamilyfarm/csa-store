import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { getDb } from "../db.js";
import { recipes } from "../schema.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const seed = [
  {
    title: "Sunday pot roast",
    note: "How to braise with marrow bones and roots.",
    imageUrl:
      "https://images.unsplash.com/photo-1504674900247-0877df9cc836?auto=format&fit=crop&w=900&q=80",
    ingredients: [
      "2.5 lb beef roast",
      "2 tbsp oil",
      "1 onion, sliced",
      "3 carrots, chopped",
      "2 cups broth",
      "1 tbsp tomato paste",
      "Salt and pepper"
    ],
    steps: [
      "Season roast with salt and pepper.",
      "Sear in a heavy pot until browned on all sides.",
      "Add onion and carrots; cook 5 minutes.",
      "Stir in tomato paste, then add broth.",
      "Cover and braise at 325F for 2.5 hours."
    ]
  },
  {
    title: "Weeknight skillet eggs",
    note: "Pantry staples you already have.",
    imageUrl:
      "https://static01.nyt.com/images/2024/03/20/multimedia/20APPErex-whlf/27APPErex-whlf-jumbo.jpg?quality=75&auto=webp",
    ingredients: [
      "2 tbsp butter",
      "4 eggs",
      "1 cup spinach",
      "1/2 cup cherry tomatoes",
      "Salt and pepper"
    ],
    steps: [
      "Melt butter in a skillet over medium heat.",
      "Add spinach and tomatoes; cook until wilted.",
      "Crack eggs into the pan and cover for 3-4 minutes.",
      "Season and serve with toast."
    ]
  },
  {
    title: "Raw milk yogurt",
    note: "Simple cultures, low heat, big flavor.",
    imageUrl:
      "https://www.preciouscore.com/wp-content/uploads/2018/08/homemade-yogurt-tips.jpg",
    ingredients: [
      "4 cups raw milk",
      "2 tbsp live-culture yogurt",
      "Clean jar"
    ],
    steps: [
      "Warm milk to 110F, then remove from heat.",
      "Stir in live-culture yogurt.",
      "Cover and keep warm 8-12 hours.",
      "Chill for 4 hours before serving."
    ]
  }
];

async function run() {
  const db = getDb();
  for (const recipe of seed) {
    await db.insert(recipes).values({
      title: recipe.title,
      note: recipe.note,
      imageUrl: recipe.imageUrl,
      ingredientsJson: JSON.stringify(recipe.ingredients),
      stepsJson: JSON.stringify(recipe.steps),
      published: 1,
      createdAt: new Date(),
      updatedAt: new Date()
    });
  }
  console.log("Seeded recipes:", seed.length);
  process.exit(0);
}

run().catch((err) => {
  console.error("Seed recipes failed:", err);
  process.exit(1);
});
