const paystack = require('paystack')(process.env.PAYSTACK_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const EXCHANGE_RATE = parseFloat(process.env.EXCHANGE_RATE) || 1460;
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
    const { userId, email, amount, currency, method, details } = req.body;

    if (!userId || !amount || !method) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields'
      });
    }

    // Check user's earnings balance
    const { data: txs, error: txsError } = await supabase
      .from('transactions')
      .select('*')
      .eq('user_id', userId)
      .in('type', ['credit', 'referral', 'daily_reward', 'ad_reward']);

    if (txsError) throw txsError;

    let earningsBalance = 0;
    if (txs) {
      txs.forEach(tx => {
        earningsBalance += parseFloat(tx.amount) || 0;
      });
    }

    if (amount > earningsBalance) {
      return res.status(400).json({
        success: false,
        message: 'Insufficient earnings balance'
      });
    }

    // Calculate withdrawal amount in fiat
    const withdrawalAmountFiat = amount * TOKEN_PRICE;
    const withdrawalAmount = currency === 'NGN' 
      ? Math.round(withdrawalAmountFiat * EXCHANGE_RATE * 100) / 100 // Convert to Naira
      : withdrawalAmountFiat;

    if (withdrawalAmount < 1.5) { // Minimum $1.5 equivalent
      return res.status(400).json({
        success: false,
        message: 'Minimum withdrawal amount is $1.5 equivalent'
      });
    }

    // Check if user has Paystack customer ID
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('paystack_customer_id, wallet_connected')
      .eq('id', userId)
      .single();

    if (userError || !user?.paystack_customer_id || !user.wallet_connected) {
      return res.status(400).json({
        success: false,
        message: 'Please connect your Paystack wallet first'
      });
    }

    let transfer;
    if (method === 'bank') {
      // Initialize transfer recipient
      const recipient = await paystack.transferrecipient.create({
        type: 'nuban',
        name: details.accountName,
        account_number: details.accountNumber,
        bank_code: await getBankCode(details.bankName), // You need to implement this
        currency: 'NGN'
      });

      if (!recipient.status) {
        throw new Error('Failed to create transfer recipient: ' + recipient.message);
      }

      // Create transfer
      transfer = await paystack.transfer.create({
        source: 'balance',
        amount: Math.round(withdrawalAmount * 100), // Convert to kobo
        recipient: recipient.data.recipient_code,
        reason: `Withdrawal from SupremeAmer - ${amount} $SA tokens`
      });

    } else if (method === 'mobile_money') {
      // Mobile money transfer (Africa-focused)
      transfer = await paystack.transfer.create({
        source: 'balance',
        amount: Math.round(withdrawalAmount * 100),
        recipient: details.mobileNumber,
        reason: `Mobile money withdrawal from SupremeAmer`,
        currency: 'GHS' // or 'UGX', 'TZS', etc. based on provider
      });
    }

    if (!transfer.status) {
      throw new Error('Transfer failed: ' + transfer.message);
    }

    // Record withdrawal in database
    const { data: withdrawal, error: withdrawalError } = await supabase
      .from('withdrawals')
      .insert({
        user_id: userId,
        token_amount: amount,
        fiat_amount: withdrawalAmount,
        currency: currency,
        method: method,
        details: details,
        status: 'pending',
        reference: transfer.data.reference || 'WITHDRAW_' + Date.now(),
        paystack_transfer_id: transfer.data.id,
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (withdrawalError) throw withdrawalError;

    // Deduct from user's earnings balance
    await supabase
      .from('transactions')
      .insert({
        user_id: userId,
        type: "withdrawal",
        amount: -amount,
        date: new Date().toISOString(),
        description: `Withdrawal request (${method}) - ${currency}`,
        status: "pending",
        reference: withdrawal.reference
      });

    return res.status(200).json({
      success: true,
      message: 'Withdrawal request submitted successfully',
      withdrawal_id: withdrawal.id,
      amount: withdrawalAmount,
      currency: currency,
      reference: withdrawal.reference,
      estimated_time: '24-48 hours'
    });

  } catch (error) {
    console.error('Error processing withdrawal:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to process withdrawal'
    });
  }
}

// Helper function to get bank code (you'll need to implement this properly)
async function getBankCode(bankName) {
  // This is a simplified version - you should use Paystack's bank list API
  const bankCodes = {
    'Access Bank': '044',
    'GTBank': '058',
    'Zenith Bank': '057',
    'First Bank': '011',
    'UBA': '033',
    'Ecobank': '050'
  };
  
  return bankCodes[bankName] || '044'; // Default to Access Bank
}