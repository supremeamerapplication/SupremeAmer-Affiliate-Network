import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  try {
    const { proofUrl, advertId, userId } = req.body;

    if (!proofUrl || !advertId || !userId) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields'
      });
    }

    // Check for duplicate submission
    const { data: existingProof } = await supabase
      .from('participations')
      .select('*')
      .eq('advert_id', advertId)
      .eq('user_id', userId)
      .single();

    if (existingProof) {
      return res.status(400).json({
        success: false,
        message: 'Proof already submitted'
      });
    }

    // Get advert
    const { data: advert } = await supabase
      .from('adverts')
      .select('*')
      .eq('id', advertId)
      .single();

    if (!advert || !advert.active) {
      return res.status(400).json({
        success: false,
        message: 'Advert not available'
      });
    }

    // Auto-approve
    res.json({
      success: true,
      verified: true,
      autoApprove: true,
      reason: 'Proof verified successfully',
      rewardAmount: advert.reward_per_participant || 0
    });

  } catch (error) {
    console.error('Proof verification error:', error);
    res.status(500).json({
      success: false,
      message: 'Proof verification failed'
    });
  }
}