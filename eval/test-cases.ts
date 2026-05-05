/**
 * 20 real test cases drawn from production inventory, with adjudicated
 * correctness based on the actual Shopify taxonomy structure (not by
 * comparing against any model's output).
 *
 * Each case has:
 *   - input: the query as sent to mapCategory or mapProduct
 *   - mode: 'category' (Amazon path) | 'product' (raw title)
 *   - label: short human description
 *   - right: full_name patterns that count as best-fit answers
 *   - acceptable: full_name patterns that are close enough (correct neighborhood)
 *   - everything else is treated as wrong
 */

export interface TestCase {
  label: string;
  mode: 'category' | 'product';
  input: string;
  right: RegExp[];
  acceptable: RegExp[];
}

export const TEST_CASES: TestCase[] = [
  {
    label: 'iPad case',
    mode: 'category',
    input: 'Electronics > Computers & Accessories > Tablet Accessories > Bags, Cases & Sleeves > Cases',
    // Shopify has no leaf for tablet cases specifically; closest is the Tablet Accessories parent
    // or the broader Computer Covers & Skins subtree (Laptop Sleeves etc.).
    right: [/Tablet Computer Accessories$/, /Computer Covers & Skins/],
    acceptable: [/Electronics > Electronics Accessories > Computer Accessories/],
  },
  {
    label: 'Gift bags',
    mode: 'category',
    input: 'Health & Household > Stationery & Gift Wrapping Supplies > Gift Wrapping Supplies > Gift Bags',
    right: [/Party & Celebration > Gift Giving > Gift Wrapping > Gift Bags$/],
    acceptable: [/Party & Celebration > Gift Giving > Gift Wrapping/],
  },
  {
    label: 'Greeting card',
    mode: 'category',
    input: 'Office Products > Office & School Supplies > Paper > Cards & Card Stock > Greeting Cards',
    right: [/Greeting & Note Cards > Greeting Cards$/],
    acceptable: [/Greeting & Note Cards/, /General Office Supplies > Paper Products > Stationery$/],
  },
  {
    label: 'TV wall mount',
    mode: 'category',
    input: 'Electronics > Television & Video > Accessories > TV Mounts, Stands & Turntables > TV Wall & Ceiling Mounts',
    right: [/TV & Monitor Mounts$/],
    acceptable: [/Television Parts & Accessories/],
  },
  {
    label: 'Disco ball car accessory',
    mode: 'category',
    input: 'Home & Kitchen > Home Décor Products > Home Décor Accents > Hanging Ornaments',
    right: [/Special Effects > Disco Balls$/],
    acceptable: [/Decor > Seasonal & Holiday Decorations/, /Decor > Lawn Ornaments/],
  },
  {
    label: 'Digital caliper',
    mode: 'category',
    input: 'Industrial & Scientific > Test, Measure & Inspect > Dimensional Measurement > Calipers > Digital Calipers',
    right: [/Calipers > Digital Calipers$/],
    acceptable: [/Measuring Tools & Sensors > Calipers/],
  },
  {
    label: 'Ignition coil',
    mode: 'category',
    input: 'Automotive > Replacement Parts > Ignition Parts > Coil Packs',
    right: [/Ignition Components > Ignition Coils$/],
    acceptable: [/Motor Vehicle Engine Parts/],
  },
  {
    label: 'Sump pump alarm',
    mode: 'category',
    input: 'Tools & Home Improvement > Safety & Security > Household Sensors & Alarms > Water Detectors & Alarms',
    right: [/Water & Flood Detectors/],
    acceptable: [/Flood, Fire & Gas Safety/, /Business & Home Security > Home Alarm Systems$/],
  },
  {
    label: 'Men sneakers',
    mode: 'category',
    input: 'Clothing, Shoes & Jewelry > Men > Shoes > Fashion Sneakers',
    right: [/Apparel & Accessories > Shoes > Sneakers$/, /Apparel & Accessories > Shoes > Athletic Shoes$/],
    acceptable: [/Apparel & Accessories > Shoes/],
  },
  {
    label: 'iPhone screen protector',
    mode: 'category',
    input: 'Cell Phones & Accessories > Accessories > Maintenance, Upkeep & Repairs > Screen Protectors',
    right: [/Mobile Phone Screen Protectors$/, /Electronics Films & Shields > Screen Protectors$/],
    acceptable: [/Electronics Films & Shields/, /Mobile & Smart Phone Accessories/],
  },
  {
    label: 'Tempura fryer',
    mode: 'category',
    input: 'Home & Kitchen > Kitchen & Dining > Small Appliances > Fryers > Deep Fryers',
    right: [/Kitchen Appliances > Deep Fryers$/],
    acceptable: [/Kitchen & Dining > Kitchen Appliances/],
  },
  {
    label: 'Costume wig',
    mode: 'category',
    input: 'Clothing, Shoes & Jewelry > Costumes & Accessories > Women > Wigs',
    right: [/Hair Accessories > Wigs$/],
    acceptable: [/Costumes & Accessories > Costume Accessories$/, /Apparel & Accessories > Costumes & Accessories/],
  },
  {
    label: 'Comforter set',
    mode: 'category',
    input: 'Home & Kitchen > Bedding > Comforters & Sets > Comforter Sets',
    right: [/Bedding > Bedding Sets$/],
    acceptable: [/Bedding > Quilts & Comforters$/, /Linens & Bedding > Bedding/],
  },
  {
    label: 'Cake topper (grocery!)',
    mode: 'category',
    input: 'Grocery & Gourmet Food > Pantry Staples > Cooking & Baking > Frosting, Icing & Decorations > Edible Cake Toppers',
    right: [/Cooking & Baking Ingredients > Edible Baking Decorations$/],
    acceptable: [/Cooking & Baking Ingredients/],
  },
  {
    label: 'Poetry book',
    mode: 'category',
    input: 'Books > Subjects > Literature & Fiction > Poetry > Themes & Styles > Religious',
    right: [/Media > Books > Print Books$/],
    acceptable: [/Media > Books/],
  },
  {
    label: 'Camping shower',
    mode: 'category',
    input: 'Sports & Outdoors > Outdoor Recreation > Camping & Hiking > Personal Care > Showers',
    right: [/Portable Showers & Privacy Enclosures > Portable Showers$/, /Portable Toilets & Showers/],
    acceptable: [/Outdoor Recreation > Camping & Hiking/],
  },
  {
    label: 'Blackout curtains',
    mode: 'category',
    input: 'Home & Kitchen > Home Décor Products > Window Treatments > Curtains & Drapes > Panels',
    right: [/Window Treatments > Curtains & Drapes > Curtains$/],
    acceptable: [/Window Treatments > Curtains & Drapes/],
  },
  {
    label: 'Guinea pig cage liner',
    mode: 'category',
    input: 'Pet Supplies > Small Animals > Houses & Habitats > Bedding & Litter',
    right: [/Small Animal Supplies > Small Animal Bedding$/],
    acceptable: [/Small Animal Supplies/],
  },
  {
    label: 'School backdrop (title only)',
    mode: 'product',
    input: 'First Day of Preschool Backdrop - Welcome Back to School Banner, Colorful First Day of School Background, 2024 Back to School Party Decorations for School Classroom, 82 x 59 Inch',
    right: [/Party Supplies > Banners$/],
    acceptable: [/Party & Celebration > Party Supplies/, /Party & Celebration/],
  },
  {
    label: 'Reading glasses (title only)',
    mode: 'product',
    input: 'Suertree 2 Pack Reading Glasses Blue Light Blocking Anti Glare UV Ray Eyeglasses Men Women Computer Eyewear Eye Protection Reader Aid Lightweight',
    right: [/Vision Care > Eyeglasses$/],
    acceptable: [/Vision Care/],
  },
];
