const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  try {
    const { proofUrl, proofPath, advertId, userId, posterId } = req.body;

    if (!proofUrl || !advertId || !userId) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields'
      });
    }

    // Basic AI verification simulation
    // In production, you might want to use a real AI service or manual review
    const autoApprove = Math.random() > 0.3; // 70% auto-approve rate for demo

    return res.status(200).json({
      verified: true,
      autoApprove: autoApprove,
      reason: autoApprove ? 'Proof appears valid' : 'Needs manual review',
      review_required: !autoApprove
    });

  } catch (error) {
    console.error('Error verifying proof:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to verify proof'
    });
  }
}