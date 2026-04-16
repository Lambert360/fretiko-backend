-- Insert dummy about content for testing
INSERT INTO about_content (
    id,
    section,
    title,
    content,
    order_num,
    image,
    is_active,
    created_at,
    updated_at
) VALUES 
    ('00000000-0000-0000-0000-000000000001', 'mission', 'Our Mission', 
     'To revolutionize commerce across Africa through innovative technology, reliable partnerships, and exceptional service delivery. We connect businesses with the commerce solutions they need to thrive in the modern economy.

## Our Core Values

### Innovation
We constantly push the boundaries of what''s possible in commerce, leveraging cutting-edge technology to solve real-world problems.

### Reliability
Businesses depend on commerce solutions they can trust. We''ve built our platform on a foundation of reliability and transparency.

### Partnership
We believe in the power of collaboration. By working closely with our partners, we create mutual growth opportunities.

### Excellence
From user experience to delivery execution, we pursue excellence in everything we do.

## Our Impact

Since our founding, we''ve helped thousands of businesses across Africa streamline their commerce operations, saving them time and money while expanding their reach.', 
     1, '/mission-image.jpg', true, NOW(), NOW()),

    ('00000000-0000-0000-0000-000000000002', 'vision', 'Our Vision', 
     'To become the leading commerce platform in Africa, empowering businesses of all sizes with cutting-edge technology and a network of trusted partners.

## The Future We''re Building

### Pan-African Network
We''re connecting major cities and remote areas across the continent, creating a seamless commerce network that serves everyone.

### Technology-First
Every aspect of our operations is enhanced by technology - from route optimization to real-time tracking to automated matching.

### Economic Empowerment
We''re creating economic opportunities by enabling thousands of commerce entrepreneurs to build sustainable businesses.

### Global Standards
We''re bringing global commerce standards to Africa, ensuring our businesses can compete on the world stage.

## Long-Term Goals

By 2030, we aim to:
- Serve 1 million businesses across 50+ African countries
- Create 100,000+ jobs through our partner network
- Reduce commerce costs by 40% for African businesses
- Become the most trusted commerce brand on the continent', 
     2, 'https://piytfaopdlxltdczdvtk.supabase.co/storage/v1/object/public/website-content/about-content/vision-image.jpg', true, NOW(), NOW()),

    ('00000000-0000-0000-0000-000000000003', 'team', 'Our Team', 
     'Founded by a team of passionate entrepreneurs and technologists, Fretiko brings together diverse expertise from commerce, technology, and business.

## Leadership

Our leadership team combines decades of experience in:
- Commerce operations and management
- Technology development and scaling
- Business strategy and growth
- African market knowledge

## Our Culture

### Innovation-Driven
We encourage experimentation, learning, and pushing boundaries to solve tough problems.

### Customer-Obsessed
Every decision starts with "how does this create value for our users?"

### Collaborative
We work as one team across borders, functions, and backgrounds.

### Accountable
We take ownership of our commitments and deliver on our promises.

## Join Our Team

We''re always looking for talented individuals who share our vision and want to make a real impact in Africa. Check out our careers page to see current openings.', 
     3, 'https://piytfaopdlxltdczdvtk.supabase.co/storage/v1/object/public/website-content/about-content/team-image.jpg', true, NOW(), NOW()),

    ('00000000-0000-0000-0000-000000000004', 'achievements', 'Our Achievements', 
     'In just a few years, we''ve made significant progress toward our vision of transforming African commerce.

## Key Milestones

### 2023
- Launched Fretiko platform in Nigeria
- Onboarded 100+ commerce partners
- Processed 50,000+ transactions
- Raised seed funding from top investors

### 2024
- Expanded to 5 new African countries
- Launched mobile apps for partners and customers
- Achieved 99.5% on-time delivery rate
- Grew team to 50+ employees

## Recognition

### Industry Awards
- "Most Innovative Commerce Startup" - African Tech Awards 2023
- "Best B2B Platform" - Commerce Excellence Awards 2024

### Media Features
- Featured in TechCabal, Ventures Africa, and other leading publications
- Recognized as one of "Top 10 African Startups to Watch"

## Impact Metrics

### Business Impact
- Helped partners increase revenue by average of 35%
- Reduced customer commerce costs by 28%
- Created 2,000+ indirect jobs through our partner network

### Social Impact
- Served businesses in underserved communities
- Enabled female entrepreneurship in commerce
- Contributed to digital inclusion across Africa', 
     4, 'https://piytfaopdlxltdczdvtk.supabase.co/storage/v1/object/public/website-content/about-content/achievements-image.jpg', true, NOW(), NOW())
ON CONFLICT (id) DO UPDATE SET
    section = EXCLUDED.section,
    title = EXCLUDED.title,
    content = EXCLUDED.content,
    order_num = EXCLUDED.order_num,
    image = EXCLUDED.image,
    is_active = EXCLUDED.is_active,
    updated_at = NOW();
