import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function seedAuctionCategories() {
  console.log('🌱 Seeding auction categories...');

  const categories = [
    {
      name: 'For Collectors',
      description: 'Rare finds, vintage items, antiques, and collectible treasures',
      icon_name: 'star',
      color: '#9C27B0',
      slug: 'collectors',
      display_order: 1,
      is_active: true
    },
    {
      name: 'For Investors',
      description: 'Investment-grade items, assets, and high-value opportunities',
      icon_name: 'trending-up',
      color: '#F1C40F',
      slug: 'investors',
      display_order: 2,
      is_active: true
    },
    {
      name: 'For Lifestyle',
      description: 'Fashion, home decor, wellness, and lifestyle essentials',
      icon_name: 'heart',
      color: '#E91E63',
      slug: 'lifestyle',
      display_order: 3,
      is_active: true
    },
    {
      name: 'For Business',
      description: 'Equipment, supplies, office furniture, and business assets',
      icon_name: 'briefcase',
      color: '#3498DB',
      slug: 'business',
      display_order: 4,
      is_active: true
    },
    {
      name: 'For Mobility',
      description: 'Vehicles, bikes, automotive parts, and transportation',
      icon_name: 'car',
      color: '#FF9800',
      slug: 'mobility',
      display_order: 5,
      is_active: true
    },
    {
      name: 'For Niche',
      description: 'Unique, specialty, and hard-to-find items',
      icon_name: 'diamond',
      color: '#4CAF50',
      slug: 'niche',
      display_order: 6,
      is_active: true
    }
  ];

  const { data, error } = await supabase
    .from('auction_categories')
    .insert(categories)
    .select();

  if (error) {
    console.error('❌ Error seeding categories:', error);
    process.exit(1);
  }

  console.log('✅ Successfully seeded 6 auction categories:');
  data?.forEach(cat => console.log(`   - ${cat.name} (${cat.slug})`));
  
  process.exit(0);
}

seedAuctionCategories();

