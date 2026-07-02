/**
 * Catalog Indexing Script
 * 
 * Generates embeddings for all products and vendors that don't have one yet.
 * Run with: npx ts-node scripts/index-catalog.ts
 * 
 * Environment variables needed:
 * - SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (already in .env)
 * - EMBEDDING_API_KEY or HUGGINGFACE_API_KEY (get free token at huggingface.co/settings/tokens)
 * - EMBEDDING_MODEL (defaults to BAAI/bge-small-en-v1.5)
 */

import { ConfigService } from '@nestjs/config';
import { config } from 'dotenv';
import { createServiceSupabaseClient } from '../src/shared/supabase.client';
import axios from 'axios';

config();

const configService = new ConfigService();

const supabase = createServiceSupabaseClient(configService);

const EMBEDDING_BASE_URL = configService.get<string>('EMBEDDING_BASE_URL')
  || 'https://router.huggingface.co/hf-inference/models';
const EMBEDDING_MODEL = configService.get<string>('EMBEDDING_MODEL')
  || 'BAAI/bge-small-en-v1.5';
const EMBEDDING_API_KEY = configService.get<string>('EMBEDDING_API_KEY')
  || configService.get<string>('HUGGINGFACE_API_KEY');
const BATCH_SIZE = parseInt(configService.get<string>('INDEX_BATCH_SIZE') || '10', 10);
const DELAY_MS = parseInt(configService.get<string>('INDEX_DELAY_MS') || '500', 10);

async function embed(text: string): Promise<number[]> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (EMBEDDING_API_KEY) {
    headers['Authorization'] = `Bearer ${EMBEDDING_API_KEY}`;
  }

  const response = await axios.post(
    `${EMBEDDING_BASE_URL}/${EMBEDDING_MODEL}`,
    { inputs: text.trim(), options: { wait_for_model: true } },
    { headers, timeout: 15000 }
  );

  const raw = response.data;
  if (Array.isArray(raw) && Array.isArray(raw[0])) {
    return raw[0];
  } else if (Array.isArray(raw)) {
    return raw;
  }
  throw new Error('Unexpected embedding response format');
}

function buildProductText(p: any): string {
  return [
    p.name || '',
    p.description || '',
    p.condition || '',
    Array.isArray(p.tags) ? p.tags.join(', ') : '',
    `Price: ${p.price || 0} NGN`,
  ].filter(s => s).join(' | ');
}

function buildVendorText(v: any): string {
  return [
    v.username || '',
    v.bio || '',
    v.location || '',
    `Verified: ${v.is_verified || false}`,
  ].filter(s => s).join(' | ');
}

async function indexProducts() {
  console.log('\n📦 Indexing products...\n');

  const { data: products, error } = await supabase
    .from('products')
    .select('id, name, description, condition, tags, price')
    .eq('status', 'active')
    .is('deleted_at', null)
    .is('embedding', null)
    .limit(BATCH_SIZE);

  if (error) {
    console.error('Failed to fetch products:', error.message);
    return;
  }

  if (!products || products.length === 0) {
    console.log('✅ All products already have embeddings.');
    return;
  }

  console.log(`Found ${products.length} products needing embeddings.`);

  let success = 0;
  let failed = 0;

  for (const product of products) {
    const text = buildProductText(product);
    try {
      const embedding = await embed(text);
      if (!embedding || embedding.length === 0) {
        console.warn(`  ⚠️  Empty embedding for product ${product.id}`);
        failed++;
        continue;
      }

      const { error: updateError } = await supabase
        .from('products')
        .update({
          embedding,
          embedding_text: text,
          embedding_updated_at: new Date().toISOString(),
        })
        .eq('id', product.id);

      if (updateError) {
        console.error(`  ❌ Failed to update product ${product.id}: ${updateError.message}`);
        failed++;
      } else {
        console.log(`  ✅ Indexed product: ${product.name} (${product.id})`);
        success++;
      }
    } catch (err: any) {
      console.error(`  ❌ Failed to embed product ${product.id}: ${err.message}`);
      failed++;
    }

    await new Promise(resolve => setTimeout(resolve, DELAY_MS));
  }

  console.log(`\n📦 Products: ${success} indexed, ${failed} failed.`);
}

async function indexVendors() {
  console.log('\n🏪 Indexing vendors...\n');

  const { data: vendors, error } = await supabase
    .from('user_profiles')
    .select('id, username, bio, location, is_verified, is_seller')
    .eq('is_seller', true)
    .is('embedding', null)
    .limit(BATCH_SIZE);

  if (error) {
    console.error('Failed to fetch vendors:', error.message);
    return;
  }

  if (!vendors || vendors.length === 0) {
    console.log('✅ All vendors already have embeddings.');
    return;
  }

  console.log(`Found ${vendors.length} vendors needing embeddings.`);

  let success = 0;
  let failed = 0;

  for (const vendor of vendors) {
    const text = buildVendorText(vendor);
    try {
      const embedding = await embed(text);
      if (!embedding || embedding.length === 0) {
        console.warn(`  ⚠️  Empty embedding for vendor ${vendor.id}`);
        failed++;
        continue;
      }

      const { error: updateError } = await supabase
        .from('user_profiles')
        .update({
          embedding,
          embedding_text: text,
          embedding_updated_at: new Date().toISOString(),
        })
        .eq('id', vendor.id);

      if (updateError) {
        console.error(`  ❌ Failed to update vendor ${vendor.id}: ${updateError.message}`);
        failed++;
      } else {
        console.log(`  ✅ Indexed vendor: ${vendor.username || vendor.id} (${vendor.id})`);
        success++;
      }
    } catch (err: any) {
      console.error(`  ❌ Failed to embed vendor ${vendor.id}: ${err.message}`);
      failed++;
    }

    await new Promise(resolve => setTimeout(resolve, DELAY_MS));
  }

  console.log(`\n🏪 Vendors: ${success} indexed, ${failed} failed.`);
}

async function main() {
  console.log('========================================');
  console.log('  Fretiko Catalog Indexing Script');
  console.log('========================================');
  console.log(`Embedding model: ${EMBEDDING_MODEL}`);
  console.log(`Batch size: ${BATCH_SIZE}`);
  console.log(`Delay between items: ${DELAY_MS}ms`);

  if (!EMBEDDING_API_KEY) {
    console.warn('\n⚠️  No EMBEDDING_API_KEY set. Hugging Face free tier may rate-limit you.');
  }

  try {
    await indexProducts();
    await indexVendors();
    console.log('\n========================================');
    console.log('  Indexing complete!');
    console.log('========================================\n');
  } catch (error: any) {
    console.error('\n❌ Indexing failed:', error.message);
    process.exit(1);
  }
}

main();
