const paystack = require('paystack')(process.env.PAYSTACK_SECRET_KEY);
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
    const { email, userId, name } = req.body;

    if (!email || !userId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Email and userId are required' 
      });
    }

    // Create Paystack customer
    const customer = await paystack.customer.create({
      email,
      first_name: name || userId.substring(0, 10),
      metadata: {
        user_id: userId,
        platform: 'supremeamer'
      }
    });

    if (!customer.status) {
      throw new Error(customer.message || 'Failed to create customer');
    }

    // Store customer ID in Supabase
    const { error } = await supabase
      .from('users')
      .update({ 
        paystack_customer_id: customer.data.customer_code,
        wallet_connected: true,
        wallet_connected_at: new Date().toISOString()
      })
      .eq('id', userId);

    if (error) {
      console.error('Supabase update error:', error);
      throw error;
    }

    // Initialize wallet with zero balance
    await supabase
      .from('wallet_transactions')
      .insert({
        user_id: userId,
        type: 'initialization',
        amount: 0,
        balance: 0,
        description: 'Wallet initialization',
        status: 'completed',
        reference: 'WALLET_INIT_' + Date.now(),
        created_at: new Date().toISOString()
      });

    return res.status(200).json({
      success: true,
      customer_id: customer.data.customer_code,
      customer_email: customer.data.email,
      message: 'Wallet connected successfully'
    });

  } catch (error) {
    console.error('Error connecting wallet:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to connect wallet'
    });
  }
}