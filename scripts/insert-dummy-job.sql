-- Insert dummy job listing for testing
INSERT INTO job_listings (
    id,
    title,
    description,
    requirements,
    location,
    type,
    department,
    salary,
    status,
    created_at,
    updated_at
) VALUES (
    '00000000-0000-0000-0000-000000000000',
    'Senior React Developer',
    'We are looking for an experienced React developer to join our engineering team and help build the future of logistics in Africa. You will work on our web platform, mobile apps, and internal tools that serve thousands of businesses and delivery partners.',
    ARRAY[
        '5+ years of React development experience',
        'Strong proficiency in TypeScript and JavaScript',
        'Experience with Next.js and modern React patterns',
        'Knowledge of state management (Redux, Zustand, etc.)',
        'Experience with responsive design and cross-browser compatibility',
        'Understanding of RESTful APIs and modern backend integration',
        'Familiarity with testing frameworks (Jest, React Testing Library)',
        'Excellent problem-solving and communication skills'
    ],
    'Remote (Global)',
    'full-time',
    'Engineering',
    '$80,000 - $120,000 per year',
    'published',
    NOW(),
    NOW()
) ON CONFLICT (id) DO UPDATE SET
    title = EXCLUDED.title,
    description = EXCLUDED.description,
    requirements = EXCLUDED.requirements,
    location = EXCLUDED.location,
    type = EXCLUDED.type,
    department = EXCLUDED.department,
    salary = EXCLUDED.salary,
    status = EXCLUDED.status,
    updated_at = NOW();
