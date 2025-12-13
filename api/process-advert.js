const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const TOKEN_PRICE = parseFloat(process.env.TOKEN_PRICE) || 0.002;

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
    const { payment_id, userId, advertData } = req.body;

    if (!payment_id || !userId) {
      return res.status(400).json({
        success: false,
        message: 'Payment ID and user ID are required'
      });
    }

    // Get payment record
    const { data: payment, error: paymentError } = await supabase
      .from('ad_payments')
      .select('*')
      .eq('id', payment_id)
      .eq('user_id', userId)
      .eq('status', 'verified')
      .single();

    if (paymentError || !payment) {
      return res.status(404).json({
        success: false,
        message: 'Payment not found or already processed'
      });
    }

    // Calculate reward per participant
    let rewardPerParticipant = 0;
    switch(advertData.category) {
      case 'Social Media':
        rewardPerParticipant = 0.0029 / TOKEN_PRICE; // Convert to tokens
        break;
      case 'App Download':
        rewardPerParticipant = 0.009 / TOKEN_PRICE;
        break;
      case 'Website Visit':
        rewardPerParticipant = 0.0002 / TOKEN_PRICE;
        break;
      default:
        rewardPerParticipant = 0.0029 / TOKEN_PRICE;
    }

    // Create advert
    const { data: advert, error: advertError } = await supabase
      .from('adverts')
      .insert({
        title: advertData.title,
        category: advertData.category,
        goal: advertData.clicks,
        url: advertData.url,
        image_url: advertData.imageUrl || '',
        instructions: advertData.instructions,
        poster: userId,
        active: true,
        clicks: 0,
        max_clicks: advertData.clicks,
        reward_per_participant: rewardPerParticipant,
        payment_reference: payment.reference,
        payment_id: payment.id,
        cost: payment.amount,
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (advertError) throw advertError;

    // Update payment status
    await supabase
      .from('ad_payments')
      .update({ 
        status: 'processed',
        advert_id: advert.id,
        processed_at: new Date().toISOString()
      })
      .eq('id', payment_id);

    // Credit upload reward
    await supabase
      .from('transactions')
      .insert({
        user_id: userId,
        type: "ad_upload",
        amount: 0.00001,
        date: new Date().toISOString(),
        description: `Advert upload reward: ${advertData.title}`,
        status: "completed",
        reference: 'AD_REWARD_' + Date.now()
      });

    return res.status(200).json({
      success: true,
      message: 'Advert created successfully',
      advert_id: advert.id,
      reward: 0.00001
    });

  } catch (error) {
    console.error('Error processing advert:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to process advert'
    });
  }
}