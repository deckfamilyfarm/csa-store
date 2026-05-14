function slugifyPartnerName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function getImageExtension(partner) {
  const source = partner.imageFileName || partner.imageName || "";
  const match = String(source).match(/\.([a-z0-9]+)$/i);
  return match ? `.${match[1].toLowerCase()}` : "";
}

function buildLocalPartnerImageUrl(partner) {
  const slug = slugifyPartnerName(partner.name);
  const ext = getImageExtension(partner);
  if (!slug || !ext) return "";
  return `/images/partners/${slug}${ext}`;
}

const RAW_PARTNERS = [
  {
    name: "Deck Family Farm",
    description:
      "With over 300 certified organic acres at our home farm in Junction City, we raise six species of animals following intensive grazing practices and regenerative farming methods that are focused on building soil, air and plant health. From animal husbandry to cured meat production, we are involved in every phase of livestock farming.",
    imageName: "8986ea_cfb7a86f55e54abca2a6b660d5784495~mv2.png",
    imageWidth: 1052,
    imageHeight: 822,
    imageFileName: "Screenshot 2024-11-11 at 2.47.47 PM.png",
    alt: ""
  },
  {
    name: "Creamy Cow, LLC",
    description:
      "Creamy Cow is Deck Family Farm's on-site dairy producing raw milk and milk products, including milk, buttermilk, yogurt, butter, hard and soft cheeses and more. Our cows live on organic pasture and are milked using modern and clean equipment and practices. We test our milk regularly. We pride ourselves on raising healthy animals on rotated pasture so that we do not give antibiotics or hormones.",
    imageName: "8986ea_cb41221d38204ef29b31dfd266ef347b~mv2.png",
    imageWidth: 934,
    imageHeight: 1074,
    imageFileName: "Screen Shot 2025-06-06 at 12.37.26 PM.png",
    alt: ""
  },
  {
    name: "Grazier's Garden",
    description:
      "Graziers Garden is the vegetable, fruit, and flower growing operation located at Deck Family Farm. It is currently run by Robert Lehn and Aleathia Heimlich. Both Robert and Aleathia have extensive background in agriculture and aspire to grow food organically that is both nourishing and delicious to the consumer. Graziers Garden aims to manage the land as regeneratively as possible through: minimal disturbance, actively improving soil health, diverse planting, and refraining from synthetic fertilizers or pesticides. Overall, the desire of Graziers Garden is to create a sustainable, thriving, & resilient community.",
    imageName: "8986ea_b5eaf49f479e43f3a6089019a4908293~mv2.png",
    imageWidth: 826,
    imageHeight: 936,
    imageFileName: "Screen Shot 2025-07-04 at 12.41.00 PM.png",
    alt: ""
  },
  {
    name: "Hyland Artisanal Meats",
    description:
      "Hyland processing operates in Deck Family Farm's commercial kitchen. Operated by Jeremy Hyland, a former intern and farm apprentice, hyland processing makes suausages, broths, and lard exclusively using Deck Family Farm fresh ingredients.",
    imageName: "8986ea_bd0bd111f7254a5e9811dd89e9dbd481~mv2.jpg",
    imageWidth: 590,
    imageHeight: 590,
    imageFileName: "Screen Shot 2024-05-28 at 7.53_edited.jpg",
    alt: ""
  },
  {
    name: "Little Wings",
    description:
      "Little Wings Farm is a 10 acre farm located along the mighty Willamette River in Eugene. While growing fresh and delicious produce and flowers is their top priority, they seek to build healthy soil by growing cover crops whenever possible and applying appropriate levels of fertility. They address pest issues by dedicating large areas of our farm to flowering habitat for beneficial insects like hover flies that eat aphids.",
    imageName: "8986ea_ca96dc3a6a2643a5a23745ba31fe2ec7~mv2.jpg",
    imageWidth: 832,
    imageHeight: 624,
    imageFileName: "littlewings.JPG",
    alt: "Little Wings Farm at Deck Family Farm, Junction City, OR – Sustainable, organic farming supporting local produce and pasture-raised meats for the Eugene to Portland, OR community."
  },
  {
    name: "Lonesome Whistle",
    description:
      "Lonesome Whistle has been farming in Junction City, Oregon since 2003. They are committed to organic grain farming, responsible land management, and to provide our community with healthy, and nutritious staple foods.",
    imageName: "8986ea_1bb3ff19b3ad4081a73beec96e11a08a~mv2.jpg",
    imageWidth: 1125,
    imageHeight: 828,
    imageFileName: "IMG_2235.jpg",
    alt: "Lonesome Whistle Farm at Deck Family Farm, Junction City, OR – Growing organic grains and legumes, supporting sustainable agriculture for the Eugene to Portland, OR region."
  },
  {
    name: "Organically Grown Company",
    description:
      "Proudly & Purposefully Trust Owned In late 2018, OGC embraced the Trust Ownership structure as a bold move to make sure we stay true to our mission—a shift that’s since inspired dozens of other mission driven businesses across the U.S. We established the Sustainable Food and Agriculture Perpetual Purpose Trust (SFAPPT). We transferred majority ownership to it, solidifying our commitment to quadruple-bottom-line leadership focused on people, planet, purpose and profit. This means we focus on positive economic, social and environmental impacts while maintaining our independence forever—never to be sold. OGC proudly stands as a purpose led and trust owned organization and Benefit Company dedicated to supporting organic agriculture while benefiting all our growers, customers, coworkers and communities. By balancing the profit needed to support our mission and purpose, we show that a business can thrive while making a real difference for people and the planet. Bottom line, we get to put everything we have into growing the organic movement.",
    imageName: "8986ea_799a3d529f8c42f787d5b8fa7eecf063~mv2.png",
    imageWidth: 706,
    imageHeight: 601,
    imageFileName: "Screenshot 2025-07-21 at 2.20.37 PM.png",
    alt: ""
  },
  {
    name: "Radiant Coffee Roasters",
    description:
      "We roast all of our coffees in Northeast Portland on a 22 kilo 1938 cast iron Probat drum roaster. We source high quality coffees from small farms all over the world and roast them to peak flavor using our high standards of quality control. Each week new coffees are brought in and tasted, with only the highest quality coffees going into our offerings. Our coffee is served at our cafe in Eugene, several Portland farmers markets, and at select retail partners. In addition to selling beans at these locations, you can also order online with shipping to your door. Whether you call the Willamette Valley home, or somewhere else in the United States, we hope you will become and remain part of the Radiant family. Our goal is to set the table each morning for you to experience high quality coffee among high quality personal connections.",
    imageName: "8986ea_fb0df2520ab64549ae7bd2fd6acc2dde~mv2.png",
    imageWidth: 569,
    imageHeight: 589,
    imageFileName: "Screenshot 2025-07-21 at 2.34.45 PM.png",
    alt: ""
  },
  {
    name: "Farmhands Co-Op",
    description:
      "Farmhands Co-Op, formerly My Brothers’ Farm, stewards 320 acres in the Southern Willamette Valley. We have transitioned the farm from annual grass seed production to a diversified orchard, ranch and riparian forest. We grow with an eye toward building soil health, biodiversity, water quality, and strengthening our community.",
    imageName: "8986ea_a0ac830abd8b44cc821d823adc95f3ad~mv2.jpg",
    imageWidth: 1050,
    imageHeight: 870,
    imageFileName: "84326 (1).jpg",
    alt: ""
  },
  {
    name: "Lone Wolf Ranch",
    description:
      "The Lone Wolf Ranch is run by the York Family—Nate, Amy, Opal, and Fern. Located in western Lane County, our farm focuses on growing microgreens and elderberries. We are excited and honored to be providing fresh produce to our community.",
    imageName: "8986ea_01ef44f01d44429e9cdf8d8ee67d4676~mv2.png",
    imageWidth: 796,
    imageHeight: 796,
    imageFileName: "Screenshot 2025-01-08 at 11.14.45 AM.png",
    alt: ""
  },
  {
    name: "Elegant Elephant",
    description:
      "Elegant Elephant Fine Foods Inc. is the home of Elegant Elephant Baking Co., Belle (the elegant food truck), Vanilla Jill’s and Grown & Rooted Delivery. These companies work together to provide 100% gluten-free options while also accommodating nut, dairy, egg and soy allergies as well as vegan products. Elegant Elephant works hard to provide high quality ingredients in every product- utilizing organic ingredients as much as possible, and also supporting our local community by using many locally sourced ingredients. Elegant Elephant Baking Co., (EEBC) was founded in 2012 by Jessie Scarola. It was inspired by Jessie’s passion for a healthy lifestyle, community, and baking when she moved into a gluten-free lifestyle in 2005. Her driving force to open a 100% Gluten-Free Bakery was her recognition of the dismal selection of celiac-friendly pastries and treats. Excited to provide options to the community, she took her highly-praised homemade recipes into the Incubator Kitchen at Hummingbird Wholesale and created a whole line of gluten-free desserts and pastries. Through a combination of servicing grocery stores, cafes and coffee shops as well as joining the Lane County Farmers Market Elegant Elephant hit the ground running. In 2015 EEBC bought an adorable 1953food truck, and named it Belle. We parked it in the lot next to our incubator kitchen and tried our hand at a retail sales location- what a fun adventure!",
    imageName: "8986ea_94a75eb0ae374c3a9c147293e8c1bc47~mv2.png",
    imageWidth: 481,
    imageHeight: 490,
    imageFileName: "Screenshot 2025-07-21 at 2.37.34 PM.png",
    alt: ""
  },
  {
    name: "BNF Kombucha",
    description:
      "Our History: In 2014, BNF was born in Eugene in a small closet belonging to Kevin Warren’s mentor. Today, we have an amazing crew and a state-of-the-art 4,000 ft brew space where we continue to make new friends. Our Values: At BNF, we believe in a better world where people drink kombucha instead of high-sugar sodas. We source high-quality, local, organic ingredients for our brews and aim to make friends with our community and beyond. Local Oregon Grown Ingredients: All of our brews contain either Oregon Grown fruit or herbs or both. Our tea and herbs come from specialty vendors in Eugene. Our Honey is sourced straight from the Willamette Valley, and our blueberries are from a family farm up the Mckenzie River. Cold Pressed to ensure the highest flavor retention.",
    imageName: "8986ea_3a3011dd4163400fa3c3aeaea7a97afd~mv2.png",
    imageWidth: 1132,
    imageHeight: 687,
    imageFileName: "Screenshot 2025-07-21 at 2.28.16 PM.png",
    alt: ""
  },
  {
    name: "Creole Me Up",
    description:
      "My name is Elsy and I am originally from Jérémie, Haiti. Haiti is divided into departments, much as the US is divided into States. Jérémie is the third largest city of Haiti and is part of the Grand’Amse department. In 1991, I came to America with a full ride scholarship to study in the United States. I was among just 20 Haitian students selected for this great opportunity. I studied Food Science Technology, graduated, and then, as part of the scholarship agreement, returned to Haiti for two years. I came back to the United States in 1999 after working at the United States Agency for Development (USAID) for two years and at CARE-Haiti for six years. Currently, I am in the process of completing my MBA with a concentration in strategy. I grew up in the kitchen. In fact, in Haiti, girls don’t have a choice. As soon as my mother started cooking, my sisters and I were in the kitchen helping with all sorts of chores and my main task always was to crush the ingredients to make the épis (marinade) of the day to marinate the main meat for dinner.",
    imageName: "8986ea_104b99dca825409ab7ec23f1f2d9b383~mv2.jpg",
    imageWidth: 661,
    imageHeight: 751,
    imageFileName: "creole.JPG",
    alt: "Creole Me Up at Deck Family Farm, Junction City, OR – Offering Creole-inspired, organic sauces and seasonings for the Eugene to Portland, OR region."
  },
  {
    name: "River Ranch Oregon Olive Oil",
    description:
      "River Ranch cultivates both Arbequina and Arbosana varieties of olives in well-tended groves nestled along the banks of the North Umpqua River in Glide, Oregon. These cold-tolerant varieties have superb olive oil attributes and exceptional flavor. The Mediterranean-like micro climate of the area provides ideal growing conditions, while thrifty watering during the growing season increases the healthful polyphenol levels in the fruit. After months of careful tending we harvest early by hand, when not only taste but polyphenol levels, too, are at their height - and get them to press without delay. Although harvesting at this rather early stage of ripening means less oil is extracted, by doing so we produce a higher quality ultra-premium extra virgin olive oil. Rest assured River Ranch will never mix its premium, completely Oregon-grown olive oil with other \"sourced\" oils, as many of our competitors do.​ A true gourmet boutique Extra Virgin Olive Oil.",
    imageName: "8986ea_68418dec8b8048ba89d088683ad795d9~mv2.png",
    imageWidth: 635,
    imageHeight: 806,
    imageFileName: "Screen Shot 2024-07-22 at 4.45.35 PM.png",
    alt: "River Ranch Oregon Olive Oil at Deck Family Farm, Junction City, OR – Producing premium, organic olive oil for the Eugene to Portland, OR community."
  },
  {
    name: "Sweet Creek Foods",
    description:
      "We preserve and create quality organic products packed in glass jars, using the freshest and best ingredients in our region, mixed with a little love!",
    imageName: "8986ea_f9c31bcc463a42cb943cc0fe289f703c~mv2.png",
    imageWidth: 306,
    imageHeight: 408,
    imageFileName: "Screenshot 2025-07-21 at 2.30.13 PM.png",
    alt: ""
  },
  {
    name: "Reality Kitchen Bakery",
    description:
      "Our Mission To offer employment path experiences designed to nourish and inspire all learners, with and without disabilities, to thrive personally and professionally with supports and resources in a community inclusive setting. Your support fuels our mission and helps us bake a brighter future!",
    imageName: "8986ea_283eb6961a814de48303e45dc833a2ef~mv2.png",
    imageWidth: 518,
    imageHeight: 553,
    imageFileName: "Screenshot 2025-07-21 at 1.52.47 PM.png",
    alt: ""
  },
  {
    name: "Small Is Beautiful Farm",
    description:
      "Small is Beautiful is a small-scale diversified farm producing flowers, fruit, and produce for sale to local supporters. They are not certified but utilize Organic and biodynamic practices with minimal fossil fuel usage. Farm fertility is created on-site.",
    imageName: "8986ea_4b1108b9cbfa4f99b2239f9f3077ca5d~mv2.png",
    imageWidth: 1264,
    imageHeight: 954,
    imageFileName: "Screen Shot 2024-07-23 at 11.40.07 AM.png",
    alt: "Small is Beautiful is a small-scale diversified farm producing flowers, fruit, and produce for sale to local supporters. They are not certified but utilize Organic and biodynamic practices with minimal fossil fuel usage. Farm fertility is created on-site."
  },
  {
    name: "Red Tail Organics",
    description:
      "We are a mixed vegetable and flower farm managing about 43 acres on the Mohawk River. We are currently cultivating about 6-8 acres and work with another local farm grazing cattle on our pastures. This is our third year growing with consistent production and our second year growing both flowers and vegetables. We primarily sell to local grocery stores, restaurants, and CSA services and our farm is growing and changing quickly in these formative years. Our commitment is to produce high quality and consistent product for our customers.",
    imageName: "8986ea_67ccfafe88b84e1eb0d33d94c95d5044~mv2.png",
    imageWidth: 296,
    imageHeight: 398,
    imageFileName: "Screenshot 2025-07-01 at 6.52.36 AM.png",
    alt: ""
  },
  {
    name: "Camas Country Mill",
    description:
      "When Camas Country first opened its doors in 2011, we were the first mill of our kind to operate in the Willamette Valley in nearly eighty years. Grist mills once peppered the landscape of the valley, particularly along waterways, with mills in even the smallest communities. Over time, as the success of the seed industry pushed locally consumed grains to the margins, local mills also faded from the valley, and factory flour came to dominate pantry and grocery shelves across the Pacific Northwest.",
    imageName: "8986ea_2c081e029b3441a79e36f2f56db5c227~mv2.png",
    imageWidth: 708,
    imageHeight: 686,
    imageFileName: "Screenshot 2025-07-21 at 2.00.13 PM.png",
    alt: ""
  },
  {
    name: "Camas Swale Farm",
    description:
      "We are an Oregon Tilth-certified farm dedicated to growing high quality produce, satisfied customers, and sustainable land stewardship. We use organic principles and two decades of experience to guide our production techniques. Organic requires soil and water conservation and prohibits the use of synthetic chemicals. Production occurs on about two-thirds of our land while reserving the rest for cover crop, hedgerows and occasional rotations of row crops. Our methods emphasize nutrient cycling with compost and cover crops, and pest management through prevention including row cover and providing habitat for beneficial insects. We DO NOT use genetically modified seeds, sewage sludge, irradiation, synthetic fertilizers or pesticides. Since rooting into our forever farm property here in Coburg in 2014 we’ve worked with the NRCS on several resource conservation projects on the farm including planting over 800 native and fruiting shrubs and trees in hedges and buffers. When it comes to the end product—vegetables, herbs and berries– our goal is to provide our customers with fresh, clean, beautiful produce. This starts with the growing practices and seed choices but extends to how we manage cultivation, harvest and post-harvest handling all of which are done with attention to the quality of the crops. ​ For 15 years we have been providing Eugene and Coburg area families with CSA Crop Shares—the heart of our farm.",
    imageName: "8986ea_5bf8b2f21bd94d0b9db71e6eb0e63109~mv2.png",
    imageWidth: 980,
    imageHeight: 1044,
    imageFileName: "Screen Shot 2024-07-23 at 11.28.53 AM.png",
    alt: ""
  }
];

export const SUBSCRIBE_PARTNERS = RAW_PARTNERS.map((partner) => ({
  ...partner,
  imageUrl: buildLocalPartnerImageUrl(partner),
  alt: partner.alt || `${partner.name} partner image`
}));
