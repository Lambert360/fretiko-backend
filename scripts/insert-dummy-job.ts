import { createServiceSupabaseClient } from '../src/shared/supabase.client';
import { ConfigService } from '@nestjs/config';

async function insertDummyJob() {
  const configService = new ConfigService();
  const supabase = createServiceSupabaseClient(configService);

  console.log('Inserting dummy job listing...');

  const { data, error } = await supabase
    .from('job_listings')
    .upsert({
      id: '00000000-0000-0000-0000-000000000000',
      title: 'Senior React Developer',
      description: 'We are looking for an experienced React developer to join our engineering team and help build the future of logistics in Africa. You will work on our web platform, mobile apps, and internal tools that serve thousands of businesses and delivery partners.',
      requirements: [
        '5+ years of React development experience',
        'Strong proficiency in TypeScript and JavaScript',
        'Experience with Next.js and modern React patterns',
        'Knowledge of state management (Redux, Zustand, etc.)',
        'Experience with responsive design and cross-browser compatibility',
        'Understanding of RESTful APIs and modern backend integration',
        'Familiarity with testing frameworks (Jest, React Testing Library)',
        'Excellent problem-solving and communication skills'
      ],
      location: 'Remote (Global)',
      type: 'full-time',
      department: 'Engineering',
      salary: '$80,000 - $120,000 per year',
      status: 'published',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }, {
      onConflict: 'id'
    })
    .select()
    .single();

  if (error) {
    console.error('Error inserting dummy job:', error);
  } else {
    console.log('Dummy job inserted successfully:', data);
  }

  // Verify the job was inserted
  const { data: jobs, error: fetchError } = await supabase
    .from('job_listings')
    .select('*')
    .eq('status', 'published');

  if (fetchError) {
    console.error('Error fetching jobs:', fetchError);
  } else {
    console.log('Published jobs in database:', jobs);
  }
}

insertDummyJob()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Script failed:', error);
    process.exit(1);
  });
