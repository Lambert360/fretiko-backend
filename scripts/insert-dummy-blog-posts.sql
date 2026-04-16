-- Insert dummy blog posts for testing
INSERT INTO blog_posts (
    id,
    title,
    content,
    excerpt,
    author,
    status,
    slug,
    tags,
    featured_image,
    reading_time,
    published_at,
    created_at,
    updated_at
) VALUES 
    ('00000000-0000-0000-0000-000000000001', 'Welcome to Fretiko Blog', 
     '# Welcome to Our Blog

We''re excited to launch the official Fretiko blog! This is where we''ll share updates about our commerce platform, partnership opportunities, and the future of delivery in Africa.

## Our Mission

At Fretiko, we''re revolutionizing commerce through innovative technology and trusted partnerships. Our platform connects businesses with reliable commerce solutions, making delivery faster, more efficient, and more accessible.

## What to Expect

In this blog, you''ll find:
- Company updates and milestones
- Partnership success stories
- Industry insights and trends
- Tips for commerce businesses
- Technology behind our platform

## Join the Conversation

We believe in transparency and community. Whether you''re a potential partner, customer, or just curious about commerce innovation, this blog is for you.

Stay tuned for regular updates, and feel free to reach out with topics you''d like us to cover!', 
     'Welcome to our blog - Learn about our latest updates and partnership opportunities', 
     'Fretiko Team', 'published', 'welcome-to-fretiko-blog', 
     ARRAY['announcement', 'company', 'mission'], '/blog-hero.jpg', 5, 
     '2024-01-15', NOW(), NOW()),

    ('00000000-0000-0000-0000-000000000002', 'How to Become a Commerce Partner', 
     '# Become a Fretiko Commerce Partner

Are you a commerce company looking to grow your business? Partnering with Fretiko opens up new opportunities and connects you with a network of businesses needing reliable delivery services.

## Why Partner with Fretiko?

### 1. Access to More Business
Our platform continuously receives delivery requests from businesses across various industries. As a partner, you get first access to these opportunities in your service areas.

### 2. Technology-Driven Operations
Leverage our cutting-edge platform to:
- Optimize delivery routes
- Track shipments in real-time
- Manage your fleet efficiently
- Access analytics and insights

### 3. Reliable Payments
Never worry about payment delays. We handle all payment processing, ensuring you get paid on time, every time.

### 4. Brand Association
Join a growing network of trusted commerce providers and enhance your company''s reputation.

## Partnership Requirements

We look for partners who:
- Have a proven track record in commerce
- Maintain high service standards
- Embrace technology
- Share our commitment to customer satisfaction

## How to Apply

Getting started is simple:

1. **Visit our Partnership Portal**: Head to [fretiko.com/partnership](/partnership)
2. **Complete the Application**: Fill out our comprehensive partnership form
3. **Submit Documentation**: Provide required business documents
4. **Review Process**: Our team reviews your application (3-5 business days)
5. **Onboarding**: Once approved, we''ll help you get set up

## Success Stories

Meet some of our successful partners:

### Swift Deliveries Ltd.
"Partnering with Fretiko increased our monthly deliveries by 40% within the first 3 months. The platform''s technology has transformed how we operate."

### Metro Logistics
"The payment reliability and access to consistent business have been game-changers for our company. We''ve expanded our fleet and team thanks to Fretiko."

## Ready to Grow?

Take the next step in your commerce business journey. Apply to become a Fretiko partner today and join the future of African commerce.

[Apply Now](/partnership)', 
     'Learn how to become a commerce partner with Fretiko and grow your business', 
     'Partnership Team', 'published', 'how-to-become-commerce-partner', 
     ARRAY['partnership', 'commerce', 'guide'], '/partnership-hero.jpg', 8, 
     '2024-01-10', NOW(), NOW()),

    ('00000000-0000-0000-0000-000000000003', 'The Future of Commerce in Africa', 
     '# The Future of Commerce in Africa

The commerce landscape in Africa is undergoing a dramatic transformation. Traditional methods are giving way to innovative, technology-driven solutions that are reshaping how goods move across the continent.

## Current Challenges

### Infrastructure Gaps
Many regions still face challenges with:
- Road networks and maintenance
- Limited tracking capabilities
- Payment processing delays
- Cross-border commerce complexity

### Market Fragmentation
The commerce sector remains highly fragmented, with many small operators lacking access to technology and larger markets.

## The Technology Revolution

### Digital Platforms
Modern commerce platforms are:
- Connecting shippers directly with providers
- Enabling real-time tracking
- Standardizing pricing
- Improving transparency

### Mobile Innovation
With mobile penetration soaring across Africa:
- On-demand delivery services are booming
- SMS-based tracking is becoming standard
- Mobile payments are simplifying transactions

### Data Analytics
Smart commerce now uses data to:
- Optimize routes in real-time
- Predict demand patterns
- Reduce delivery times
- Lower operational costs

## Fretiko''s Vision

We''re not just building another commerce app - we''re creating an ecosystem that:

### 1. Empowers Small Businesses
Level the playing field by giving small commerce companies access to technology and markets previously reserved for large players.

### 2. Creates Economic Opportunity
Generate employment and entrepreneurship opportunities in the commerce sector.

### 3. Drives Efficiency
Reduce waste, lower costs, and improve service quality across the entire supply chain.

### 4. Enables Cross-Border Trade
Simplify and accelerate commerce between African nations.

## What''s Next?

### AI and Machine Learning
Artificial intelligence will further revolutionize:
- Predictive analytics for demand forecasting
- Automated route optimization
- Smart matching of shipments to providers

### Blockchain Integration
Blockchain technology promises:
- Enhanced security and transparency
- Smart contracts for automated payments
- Immutable tracking records

### Drone and Autonomous Delivery
While still emerging, these technologies will:
- Reach remote areas efficiently
- Reduce human labor costs
- Enable 24/7 delivery operations

## Join the Revolution

The future of African commerce is being written today. Whether you''re a:
- Business needing reliable commerce
- Commerce company seeking growth
- Developer passionate about impact
- Investor in African innovation

There''s a place for you in this transformation.

Together, we''re not just moving packages - we''re moving Africa forward.', 
     'Exploring how technology is transforming commerce across the African continent', 
     'Fretiko Team', 'published', 'future-of-commerce-africa', 
     ARRAY['future', 'technology', 'innovation', 'africa'], '/future-commerce.jpg', 12, 
     '2024-01-05', NOW(), NOW())
ON CONFLICT (id) DO UPDATE SET
    title = EXCLUDED.title,
    content = EXCLUDED.content,
    excerpt = EXCLUDED.excerpt,
    author = EXCLUDED.author,
    status = EXCLUDED.status,
    slug = EXCLUDED.slug,
    tags = EXCLUDED.tags,
    featured_image = EXCLUDED.featured_image,
    reading_time = EXCLUDED.reading_time,
    updated_at = NOW();
