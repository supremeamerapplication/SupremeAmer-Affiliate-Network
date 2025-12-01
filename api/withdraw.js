const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Paystack configuration
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_BASE_URL = 'https://api.paystack.co';

// Configuration
const MIN_WITHDRAWAL_AMOUNT = parseFloat(process.env.MIN_WITHDRAWAL_AMOUNT) || 750;
const TOKEN_PRICE = parseFloat(process.env.TOKEN_PRICE) || 0.002;
const EXCHANGE_RATE = parseFloat(process.env.EXCHANGE_RATE) || 1460;

module.exports = async (req, res) => {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
    );

    // Handle preflight requests
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    // Only accept POST requests
    if (req.method !== 'POST') {
        return res.status(405).json({
            success: false,
            message: 'Method not allowed'
        });
    }

    try {
        const { userId, email, amount, amountFiat, currency, method, details } = req.body;

        if (!userId || !email || !amount || !amountFiat || !method || !details) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields'
            });
        }

        // Validate amount
        if (amount < MIN_WITHDRAWAL_AMOUNT) {
            return res.status(400).json({
                success: false,
                message: `Minimum withdrawal amount is ${MIN_WITHDRAWAL_AMOUNT} $SA`
            });
        }

        console.log(`Processing withdrawal for user: ${userId}, Amount: ${amount} $SA (${currency} ${amountFiat})`);

        // Check user's earnings balance
        const { data: transactions } = await supabase
            .from('transactions')
            .select('*')
            .eq('user_id', userId);

        if (!transactions) {
            return res.status(400).json({
                success: false,
                message: 'Unable to fetch user transactions'
            });
        }

        // Calculate earnings balance
        let earningsBalance = 0;
        transactions.forEach(tx => {
            if (tx.type === 'credit' || tx.type === 'referral' || 
                tx.type === 'daily_reward' || tx.type === 'ad_reward') {
                earningsBalance += parseFloat(tx.amount) || 0;
            }
            // Subtract withdrawals
            if (tx.type === 'withdrawal' && tx.status === 'completed') {
                earningsBalance -= Math.abs(parseFloat(tx.amount) || 0);
            }
        });

        // Check if user has sufficient earnings balance
        if (amount > earningsBalance) {
            return res.status(400).json({
                success: false,
                message: `Insufficient earnings balance. Available: ${earningsBalance.toFixed(2)} $SA`
            });
        }

        // Verify the calculated fiat amount matches the provided amount
        const calculatedFiat = amount * TOKEN_PRICE * (currency === 'NGN' ? EXCHANGE_RATE : 1);
        
        if (Math.abs(calculatedFiat - amountFiat) > 1) {
            console.warn(`Fiat amount mismatch: Calculated ${calculatedFiat}, Provided ${amountFiat}`);
        }

        // Create withdrawal record
        const withdrawalData = {
            user_id: userId,
            user_email: email,
            amount: amount,
            amount_fiat: amountFiat,
            currency: currency,
            method: method,
            details: details,
            status: 'pending',
            requested_at: new Date().toISOString()
        };

        const { data: withdrawal, error: withdrawalError } = await supabase
            .from('withdrawals')
            .insert(withdrawalData)
            .select()
            .single();

        if (withdrawalError) {
            console.error('Error creating withdrawal record:', withdrawalError);
            throw new Error(withdrawalError.message);
        }

        // Create debit transaction
        const { error: transactionError } = await supabase
            .from('transactions')
            .insert({
                user_id: userId,
                type: 'withdrawal',
                amount: -amount,
                date: new Date().toISOString(),
                description: `Withdrawal request (${method}) - ${currency} ${amountFiat}`,
                status: 'pending',
                withdrawal_id: withdrawal.id,
                metadata: {
                    withdrawalId: withdrawal.id,
                    method: method,
                    currency: currency,
                    details: details
                }
            });

        if (transactionError) {
            console.error('Error creating transaction:', transactionError);
            throw new Error(transactionError.message);
        }

        // Initiate Paystack transfer if using Paystack
        let transferResponse = null;
        let transferError = null;

        if (method === 'bank' || method === 'mobile_money') {
            try {
                // First, create transfer recipient
                const recipientData = {
                    type: method === 'bank' ? 'nuban' : 'mobile_money',
                    name: details.accountName || details.name || email,
                    account_number: method === 'bank' ? details.accountNumber : details.number,
                    bank_code: method === 'bank' ? details.bankCode : undefined,
                    currency: currency === 'NGN' ? 'NGN' : 'USD'
                };

                console.log('Creating transfer recipient:', recipientData);

                const recipientRes = await axios.post(
                    `${PAYSTACK_BASE_URL}/transferrecipient`,
                    recipientData,
                    {
                        headers: {
                            'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`,
                            'Content-Type': 'application/json'
                        }
                    }
                );

                console.log('Recipient created:', recipientRes.data);

                // Then, initiate transfer
                const transferData = {
                    source: 'balance',
                    amount: Math.round(amountFiat * 100), // Convert to kobo/pence
                    recipient: recipientRes.data.data.recipient_code,
                    reason: `SupremeAmer Withdrawal - ${withdrawal.id}`,
                    reference: `WITHDRAWAL_${withdrawal.id}_${Date.now()}`
                };

                console.log('Initiating transfer:', transferData);

                transferResponse = await axios.post(
                    `${PAYSTACK_BASE_URL}/transfer`,
                    transferData,
                    {
                        headers: {
                            'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`,
                            'Content-Type': 'application/json'
                        }
                    }
                );

                console.log('Transfer initiated:', transferResponse.data);

                // Update withdrawal with transfer details
                await supabase
                    .from('withdrawals')
                    .update({
                        transfer_code: transferResponse.data.data.transfer_code,
                        transfer_reference: transferData.reference,
                        transfer_data: transferResponse.data.data,
                        status: 'processing',
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', withdrawal.id);

            } catch (error) {
                transferError = error;
                console.error('Transfer initiation error:', error.response?.data || error.message);
                
                // Update withdrawal status to indicate manual processing required
                await supabase
                    .from('withdrawals')
                    .update({
                        status: 'manual_review',
                        notes: `Automatic transfer failed: ${error.message}`,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', withdrawal.id);
            }
        } else {
            // Other methods require manual processing
            await supabase
                .from('withdrawals')
                .update({
                    status: 'manual_review',
                    notes: 'Manual processing required for this withdrawal method',
                    updated_at: new Date().toISOString()
                })
                .eq('id', withdrawal.id);
        }

        // Send notification email (optional)
        if (process.env.SEND_WITHDRAWAL_EMAILS === 'true') {
            try {
                await sendWithdrawalEmail(email, withdrawal.id, amount, currency, amountFiat, method);
            } catch (emailError) {
                console.error('Error sending email notification:', emailError);
            }
        }

        const response = {
            success: true,
            message: 'Withdrawal request submitted successfully',
            withdrawalId: withdrawal.id,
            status: transferError ? 'manual_review' : 'processing',
            details: {
                amount: amount,
                fiatAmount: amountFiat,
                currency: currency,
                method: method
            }
        };

        if (transferError) {
            response.warning = 'Transfer initiation failed, requires manual review';
        }

        console.log(`Withdrawal request processed: ${withdrawal.id}, Status: ${response.status}`);

        res.json(response);

    } catch (error) {
        console.error('Withdrawal processing error:', error);
        res.status(500).json({
            success: false,
            message: 'Withdrawal processing failed',
            error: error.message
        });
    }
};

// Helper function to send withdrawal email
async function sendWithdrawalEmail(email, withdrawalId, amount, currency, amountFiat, method) {
    // This is a placeholder for email sending logic
    // You can integrate with SendGrid, Mailgun, etc.
    console.log(`Sending withdrawal email to ${email} for withdrawal ${withdrawalId}`);
    
    // Example using SendGrid:
    // const sgMail = require('@sendgrid/mail');
    // sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    
    // const msg = {
    //     to: email,
    //     from: 'support@supremeamer.com',
    //     subject: 'Withdrawal Request Received',
    //     html: `<h2>Withdrawal Request #${withdrawalId}</h2>
    //            <p>Your withdrawal request has been received and is being processed.</p>
    //            <p><strong>Amount:</strong> ${amount} $SA (${currency} ${amountFiat})</p>
    //            <p><strong>Method:</strong> ${method}</p>
    //            <p>You will receive a notification once your withdrawal is processed.</p>`
    // };
    
    // await sgMail.send(msg);
}