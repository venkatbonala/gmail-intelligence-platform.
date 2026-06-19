import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '../.env' });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function inspectMislabeled() {
  const subjects = [
    'We Are Live, Venkat bonala!',
    '[IMPORTANT] Starting today, Day 2',
    'last chance. 67% off One Person AI',
    'Your $200 discount is expiring',
    'you have to stop'
  ];

  for (const sub of subjects) {
    console.log(`=== Querying for subject: "${sub}" ===`);
    const { data: emails, error } = await supabase
      .from('emails')
      .select('subject, from_address, body_text, body_html, raw_text_content, raw_html_content')
      .ilike('subject', `%${sub}%`)
      .limit(1);

    if (error) {
      console.error('Error fetching email:', error);
      continue;
    }

    if (emails && emails.length > 0) {
      const email = emails[0];
      console.log(`From: ${email.from_address}`);
      console.log(`Subject: ${email.subject}`);
      
      const inBodyText = (email.body_text || '').toLowerCase().includes('unsubscribe');
      const inBodyHtml = (email.body_html || '').toLowerCase().includes('unsubscribe');
      const inRawText = (email.raw_text_content || '').toLowerCase().includes('unsubscribe');
      const inRawHtml = (email.raw_html_content || '').toLowerCase().includes('unsubscribe');
      
      console.log(`unsubscribe in body_text: ${inBodyText}`);
      console.log(`unsubscribe in body_html: ${inBodyHtml}`);
      console.log(`unsubscribe in raw_text_content: ${inRawText}`);
      console.log(`unsubscribe in raw_html_content: ${inRawHtml}`);
      
      // Let's also check if "view in browser" is present
      const kibInHtml = (email.body_html || '').toLowerCase().includes('view in browser') || (email.body_html || '').toLowerCase().includes('view online');
      console.log(`view in browser/online in body_html: ${kibInHtml}`);
    } else {
      console.log('No matching email found in DB.');
    }
    console.log('\n');
  }
}

inspectMislabeled();
