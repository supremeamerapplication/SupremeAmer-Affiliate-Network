// file: api/index.js - Vercel Serverless Function Entry Point
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const app = express();

// Middleware
app.use(cors({
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : [
        'https://supremeamer.vercel.app',
        'https://www.supremeamer.com',
        'http://localhost:3000'
    ],
    credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Security headers
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
});

// Supabase Configuration
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
if (!supabaseUrl || !supabaseKey) {
    console.error('ERROR: SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in Vercel environment variables');
}
const supabase = createClient(supabaseUrl, supabaseKey);

// Paystack Configuration
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_PUBLIC_KEY = process.env.PAYSTACK_PUBLIC_KEY;
const PAYSTACK_BASE_URL = 'https://api.paystack.co';

// Application Constants
const TOKEN_PRICE = parseFloat(process.env.TOKEN_PRICE) || 0.002;
const EXCHANGE_RATE = parseFloat(process.env.EXCHANGE_RATE) || 1460;

// Database Functions
async function getUserBalance(userId) {
    try {
        const { data, error } = await supabase.rpc('get_user_balance', {
            user_id: userId
        });
        
        if (error) throw error;
        return {
            total: data?.total || 0,
            topup: data?.topup || 0,
            earnings: data?.earnings || 0,
            pending: data?.pending || 0
        };
    } catch (error) {
        console.error('Error getting user balance:', error);
        return { total: 0, topup: 0, earnings: 0, pending: 0 };
    }
}

async function createTransaction(transactionData) {
    try {
        const { data, error } = await supabase
            .from('transactions')
            .insert(transactionData)
            .select()
            .single();
        
        if (error) throw error;
        return { success: true, data };
    } catch (error) {
        console.error('Error creating transaction:', error);
        return { success: false, error: error.message };
    }
}

// Paystack Functions
async function verifyPaystackPayment(reference) {
    try {
        const response = await axios.get(
            `${PAYSTACK_BASE_URL}/transaction/verify/${reference}`,
            {
                headers: {
                    'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            }
        );

        const data = response.data;
        
        if (!data.status) {
            return {
                success: false,
                message: data.message || 'Verification failed'
            };
        }

        if (data.data.status !== 'success') {
            return {
                success: false,
                message: `Payment status: ${data.data.status}`,
                data: data.data
            };
        }

        return {
            success: true,
            message: 'Payment verified successfully',
            data: data.data
        };
    } catch (error) {
        console.error('Paystack verification error:', error.response?.data || error.message);
        return {
            success: false,
            message: error.response?.data?.message || 'Payment verification failed',
            error: error.message
        };
    }
}

// Verify Paystack webhook signature
function verifyPaystackSignature(req) {
    const signature = req.headers['x-paystack-signature'];
    if (!signature) {
        console.error('No signature provided in webhook');
        return false;
    }
    
    try {
        const hash = crypto
            .createHmac('sha512', PAYSTACK_SECRET_KEY)
            .update(JSON.stringify(req.body))
            .digest('hex');
        
        return hash === signature;
    } catch (error) {
        console.error('Error verifying signature:', error);
        return false;
    }
}

// API Endpoints

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        service: 'SupremeAmer Payment API',
        version: '1.0.0',
        environment: process.env.VERCEL_ENV || 'production'
    });
});

// Verify payment
app.post('/api/verify-payment', async (req, res) => {
    try {
        const { reference, type, userId, email, metadata } = req.body;

        // Validate required fields
        if (!reference || !type || !userId || !email) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: reference, type, userId, email'
            });
        }

        // Check if transaction already exists
        const { data: existingTx } = await supabase
            .from('transactions')
            .select('*')
            .eq('payment_reference', reference)
            .single();

        if (existingTx) {
            return res.json({
                success: true,
                message: 'Payment already processed',
                transaction: existingTx,
                alreadyProcessed: true
            });
        }

        // Verify payment with Paystack
        const verification = await verifyPaystackPayment(reference);
        
        if (!verification.success) {
            return res.status(400).json({
                success: false,
                message: verification.message || 'Payment verification failed',
                details: verification.data
            });
        }

        const paymentData = verification.data;
        const amountPaid = paymentData.amount / 100; // Convert from kobo

        // Calculate tokens based on payment type
        let tokens = 0;
        let description = '';
        
        if (type === 'topup') {
            // 1 NGN = 0.00001 $SA
            tokens = amountPaid * 0.00001;
            description = `Account Top-up - ₦${amountPaid.toLocaleString()}`;
        } else if (type === 'advert') {
            // Advert payment - use metadata for specific amount
            tokens = metadata?.advertTokens || 0.00001;
            description = `Advert Payment - ${metadata?.advertTitle || 'New Advert'}`;
        } else {
            return res.status(400).json({
                success: false,
                message: 'Invalid payment type'
            });
        }

        // Create transaction record
        const transactionData = {
            user_id: userId,
            type: type,
            amount: tokens,
            date: new Date().toISOString(),
            description: description,
            status: 'completed',
            payment_reference: reference,
            payment_data: paymentData,
            currency: paymentData.currency,
            amount_paid: amountPaid,
            metadata: metadata || {}
        };

        const transactionResult = await createTransaction(transactionData);
        
        if (!transactionResult.success) {
            throw new Error(transactionResult.error);
        }

        // Update user balance in real-time
        await supabase.rpc('update_user_balance', {
            user_id: userId,
            amount: tokens,
            balance_type: type === 'topup' ? 'topup' : 'earnings'
        });

        // If it's an advert payment, mark advert as paid
        if (type === 'advert' && metadata?.advertId) {
            await supabase
                .from('adverts')
                .update({
                    payment_status: 'paid',
                    payment_reference: reference,
                    paid_at: new Date().toISOString()
                })
                .eq('id', metadata.advertId);
        }

        console.log(`Payment processed: ${reference}, User: ${userId}, Tokens: ${tokens}, Type: ${type}`);

        res.json({
            success: true,
            message: 'Payment verified and processed successfully',
            tokens: tokens,
            amountPaid: amountPaid,
            currency: paymentData.currency,
            transaction: transactionResult.data
        });

    } catch (error) {
        console.error('Payment verification error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});

// Verify proof submission
app.post('/api/verify-proof', async (req, res) => {
    try {
        const { proofUrl, proofPath, advertId, userId, posterId } = req.body;

        if (!proofUrl || !advertId || !userId || !posterId) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields'
            });
        }

        // Check if user has already submitted proof for this advert
        const { data: existingProof } = await supabase
            .from('participations')
            .select('*')
            .eq('advert_id', advertId)
            .eq('user_id', userId)
            .single();

        if (existingProof) {
            return res.status(400).json({
                success: false,
                message: 'Proof already submitted for this advert'
            });
        }

        // Get advert details
        const { data: advert } = await supabase
            .from('adverts')
            .select('*')
            .eq('id', advertId)
            .single();

        if (!advert) {
            return res.status(404).json({
                success: false,
                message: 'Advert not found'
            });
        }

        if (!advert.active) {
            return res.status(400).json({
                success: false,
                message: 'Advert is no longer active'
            });
        }

        // For now, auto-approve all proofs
        const autoApprove = true;
        
        res.json({
            success: true,
            verified: true,
            autoApprove: autoApprove,
            reason: autoApprove ? 'Proof verified successfully' : 'Proof requires manual review',
            rewardAmount: advert.reward_per_participant || 0
        });

    } catch (error) {
        console.error('Proof verification error:', error);
        res.status(500).json({
            success: false,
            message: 'Proof verification failed'
        });
    }
});

// Withdrawal endpoint
app.post('/api/withdraw', async (req, res) => {
    try {
        const { userId, email, amount, amountFiat, currency, method, details } = req.body;

        if (!userId || !email || !amount || !amountFiat || !method) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields'
            });
        }

        // Check user balance
        const balance = await getUserBalance(userId);
        
        if (amount > balance.earnings) {
            return res.status(400).json({
                success: false,
                message: 'Insufficient earnings balance'
            });
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

        const { data: withdrawal, error } = await supabase
            .from('withdrawals')
            .insert(withdrawalData)
            .select()
            .single();

        if (error) throw error;

        // Create debit transaction
        await supabase
            .from('transactions')
            .insert({
                user_id: userId,
                type: 'withdrawal',
                amount: -amount,
                date: new Date().toISOString(),
                description: `Withdrawal request (${method}) - ${currency} ${amountFiat}`,
                status: 'pending',
                withdrawal_id: withdrawal.id
            });

        // Initiate Paystack transfer
        let transferResponse;
        try {
            const recipientData = {
                type: method === 'bank' ? 'nuban' : 'mobile_money',
                name: details.accountName || details.name || email,
                account_number: details.accountNumber || details.number,
                bank_code: method === 'bank' ? details.bankCode : null,
                currency: currency === 'NGN' ? 'NGN' : 'USD'
            };

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

            const transferData = {
                source: 'balance',
                amount: Math.round(amountFiat * 100),
                recipient: recipientRes.data.data.recipient_code,
                reason: `SupremeAmer Withdrawal - ${withdrawal.id}`
            };

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

            // Update withdrawal with transfer details
            await supabase
                .from('withdrawals')
                .update({
                    transfer_code: transferResponse.data.data.transfer_code,
                    transfer_data: transferResponse.data.data,
                    status: 'processing'
                })
                .eq('id', withdrawal.id);

        } catch (transferError) {
            console.error('Transfer initiation error:', transferError.response?.data || transferError.message);
            
            // Mark as manual processing required
            await supabase
                .from('withdrawals')
                .update({
                    status: 'manual_review',
                    notes: `Automatic transfer failed: ${transferError.message}`
                })
                .eq('id', withdrawal.id);
        }

        res.json({
            success: true,
            message: 'Withdrawal request submitted successfully',
            withdrawalId: withdrawal.id,
            status: 'pending'
        });

    } catch (error) {
        console.error('Withdrawal error:', error);
        res.status(500).json({
            success: false,
            message: 'Withdrawal processing failed'
        });
    }
});

// Paystack Webhook Handler
app.post('/api/webhook/paystack', async (req, res) => {
    try {
        // Verify webhook signature
        if (!verifyPaystackSignature(req)) {
            console.error('Invalid webhook signature');
            return res.status(401).json({ success: false, message: 'Invalid signature' });
        }

        const event = req.body;
        console.log(`Paystack webhook received: ${event.event}`, {
            reference: event.data?.reference,
            amount: event.data?.amount
        });

        switch (event.event) {
            case 'charge.success':
                await handleChargeSuccess(event.data);
                break;
                
            case 'transfer.success':
                await handleTransferSuccess(event.data);
                break;
                
            case 'transfer.failed':
                await handleTransferFailed(event.data);
                break;
                
            default:
                console.log(`Unhandled webhook event: ${event.event}`);
        }

        res.json({ success: true, message: 'Webhook processed' });
    } catch (error) {
        console.error('Webhook processing error:', error);
        res.status(500).json({ success: false, message: 'Webhook processing failed' });
    }
});

// Webhook handlers
async function handleChargeSuccess(data) {
    try {
        const reference = data.reference;
        
        const { data: transaction } = await supabase
            .from('transactions')
            .select('*')
            .eq('payment_reference', reference)
            .single();

        if (transaction && transaction.status !== 'completed') {
            await supabase
                .from('transactions')
                .update({
                    status: 'completed',
                    updated_at: new Date().toISOString()
                })
                .eq('id', transaction.id);
        }
        
    } catch (error) {
        console.error('Error handling charge success:', error);
    }
}

async function handleTransferSuccess(data) {
    try {
        const transferCode = data.transfer_code;
        
        const { data: withdrawal } = await supabase
            .from('withdrawals')
            .select('*')
            .eq('transfer_code', transferCode)
            .single();

        if (withdrawal) {
            await supabase
                .from('withdrawals')
                .update({
                    status: 'completed',
                    completed_at: new Date().toISOString(),
                    transfer_data: data
                })
                .eq('id', withdrawal.id);

            await supabase
                .from('transactions')
                .update({ 
                    status: 'completed',
                    updated_at: new Date().toISOString()
                })
                .eq('withdrawal_id', withdrawal.id);

            console.log(`Withdrawal completed: ${withdrawal.id}`);
        }
        
    } catch (error) {
        console.error('Error handling transfer success:', error);
    }
}

async function handleTransferFailed(data) {
    try {
        const transferCode = data.transfer_code;
        
        const { data: withdrawal } = await supabase
            .from('withdrawals')
            .select('*')
            .eq('transfer_code', transferCode)
            .single();

        if (withdrawal) {
            await supabase
                .from('withdrawals')
                .update({
                    status: 'failed',
                    failed_at: new Date().toISOString(),
                    failure_reason: data.reason,
                    transfer_data: data
                })
                .eq('id', withdrawal.id);

            await supabase
                .from('transactions')
                .update({ 
                    status: 'failed',
                    updated_at: new Date().toISOString()
                })
                .eq('withdrawal_id', withdrawal.id);

            await supabase.rpc('update_user_balance', {
                user_id: withdrawal.user_id,
                amount: withdrawal.amount,
                balance_type: 'earnings'
            });

            console.log(`Withdrawal failed: ${withdrawal.id}`);
        }
        
    } catch (error) {
        console.error('Error handling transfer failed:', error);
    }
}

// Error handling
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    
    res.status(500).json({
        success: false,
        message: 'Internal server error'
    });
});

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({
        success: false,
        message: 'Endpoint not found'
    });
});

// Export for Vercel
module.exports = app;