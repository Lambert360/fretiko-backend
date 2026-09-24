# Fretiko AI Assistant

This module implements the MVP AI assistant for Fretiko, focused on product and vendor discovery. It uses an OpenAI-compatible LLM API for chat and intent classification, plus RAG (Retrieval-Augmented Generation) with pgvector for semantic product/vendor search.

## Architecture

```
src/ai/
├── core/              # LLM, embedding, vector search, intent classification, context, response generation
├── agents/            # Shopping and discovery agents
├── tools/             # Product search, vendor search, reviews, trending
├── memory/            # Conversation memory and preference learning
├── guards/            # Permission and cost tracking
├── dto/               # DTOs and interfaces
├── price-alert.service.ts  # Price alert CRUD
└── ai.controller.ts   # REST endpoints
```

## Supported Intents

- `product_search` — Find products
- `vendor_search` — Find verified sellers
- `comparison` — Compare products
- `trending` — Show popular products/vendors
- `general_chat` — Greetings and unrelated messages

## LLM Setup

The backend expects an OpenAI-compatible endpoint. You can use a managed provider (recommended for startups) or self-host.

### Option 1: Groq (Free tier — recommended)

1. Sign up at [console.groq.com](https://console.groq.com)
2. Create an API key
3. Set in `.env`:

```bash
LLM_BASE_URL=https://api.groq.com/openai/v1
LLM_MODEL=llama-3.3-70b-versatile
LLM_API_KEY=gsk_your_key_here
```

### Option 2: Together AI (Paid, has embeddings too)

```bash
LLM_BASE_URL=https://api.together.xyz/v1
LLM_MODEL=Qwen/Qwen2.5-7B-Instruct-Turbo
LLM_API_KEY=your_key_here
```

### Option 3: Self-hosted (vLLM, Ollama, TGI)

```bash
LLM_BASE_URL=http://localhost:8000/v1
LLM_MODEL=qwen2.5-7b-instruct
```

### Model tiers (optional)

```bash
LLM_FAST_BASE_URL=https://api.groq.com/openai/v1
LLM_FAST_MODEL=llama-3.1-8b-instant
LLM_BALANCED_BASE_URL=https://api.groq.com/openai/v1
LLM_BALANCED_MODEL=llama-3.3-70b-versatile
LLM_STRONG_BASE_URL=https://api.together.xyz/v1
LLM_STRONG_MODEL=Qwen/Qwen2.5-72B-Instruct-Turbo
```

## RAG (Retrieval-Augmented Generation)

The AI assistant uses semantic vector search to find relevant products and vendors, improving search quality beyond keyword matching.

### How it works

1. User query is embedded into a vector (Hugging Face free tier)
2. Vector similarity search runs in Supabase pgvector
3. Top matching products/vendors are retrieved
4. Retrieved data is passed to the LLM as context for response generation
5. If vector search fails or returns no results, keyword search is used as fallback

### Embedding setup (Hugging Face — free)

1. Get a free API token at [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens)
2. Set in `.env`:

```bash
EMBEDDING_BASE_URL=https://router.huggingface.co/hf-inference/models
EMBEDDING_MODEL=BAAI/bge-small-en-v1.5
EMBEDDING_API_KEY=hf_your_free_token_here
```

### Database migration

Run the RAG migration in Supabase SQL editor:

```sql
-- File: supabase/migrations/20250623_ai_rag_pgvector.sql
-- Enables pgvector, adds embedding columns, creates match_products/match_vendors RPC functions
```

### Index your catalog

After running the migration, generate embeddings for existing products and vendors:

```bash
npx ts-node scripts/index-catalog.ts
```

This processes products and vendors that don't have embeddings yet. Run it again after adding new products to keep the index fresh. Adjust batch size and delay in `.env`:

```bash
INDEX_BATCH_SIZE=10
INDEX_DELAY_MS=500
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/ai/chat` | Main chat endpoint, returns full response |
| POST | `/api/ai/chat/stream` | SSE streaming response |
| GET | `/api/ai/conversations` | List user conversations |
| GET | `/api/ai/conversations/:id` | Get conversation history |
| GET | `/api/ai/price-alerts` | List user price alerts |
| POST | `/api/ai/price-alerts` | Create a price alert |
| DELETE | `/api/ai/price-alerts/:id` | Delete a price alert |

## Safe Actions

The AI can suggest safe actions that the backend handles directly:

- Save product to wishlist
- Follow vendor
- Set price alert
- Draft message to vendor
- Compare products
- View product/vendor details

Payment, checkout, booking, and other high-risk actions are not handled by the AI in the MVP.

## Database Tables

Run the migrations in `supabase/migrations/`:

- `20250621_ai_assistant_tables.sql` — `ai_conversations`, `ai_usage_logs`, `price_alerts`
- `20250623_ai_rag_pgvector.sql` — pgvector extension, embedding columns, `match_products`/`match_vendors` RPC functions

These tables include RLS policies so users can only access their own data.

## Cost Tracking

Every AI request is logged to `ai_usage_logs` with:

- Model used
- Input/output tokens
- Tool calls
- Latency
- Estimated cost
- Success/failure

For self-hosted models, `estimated_cost` is a placeholder based on tokens. Update `estimateCost()` in `cost-tracking.interceptor.ts` with your actual hosting costs.

## Development Tips

1. Start with Groq's free tier for zero-cost testing.
2. Use Hugging Face free tier for embeddings (1,000 requests/day).
3. If you outgrow free tiers, switch to Together AI for both LLM and embeddings.
4. For high-volume production, self-host vLLM on RunPod GPU instances.

## Setup Checklist

- [ ] Run the Supabase migration `supabase/migrations/20250621_ai_assistant_tables.sql`.
- [ ] Run the Supabase migration `supabase/migrations/20250623_ai_rag_pgvector.sql`.
- [ ] Get a Groq API key at [console.groq.com](https://console.groq.com) and set `LLM_API_KEY` in `.env`.
- [ ] Get a Hugging Face token at [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens) and set `EMBEDDING_API_KEY` in `.env`.
- [ ] Run `npm run build` to verify the backend compiles.
- [ ] Run `npx ts-node scripts/index-catalog.ts` to generate embeddings for your catalog.
- [ ] Start the backend (`npm run start:dev`) and test `POST /api/ai/chat` with a JWT token.
- [ ] Verify `POST /api/ai/chat/stream` and the price alert endpoints work.
