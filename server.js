require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const bodyParser = require('body-parser');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : '*',
    credentials: true
}));
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

// Security middleware
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
});

// Rate limiting
const rateLimit = require('express-rate-limit');
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again later.'
});
app.use('/api/', limiter);

// Supabase Configuration
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
if (!supabaseUrl || !supabaseKey) {
    console.error('ERROR: SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in .env');
    process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey);

// Paystack Configuration
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_PUBLIC_KEY = process.env.PAYSTACK_PUBLIC_KEY;
const PAYSTACK_BASE_URL = 'https://api.paystack.co';

if (!PAYSTACK_SECRET_KEY || !PAYSTACK_PUBLIC_KEY) {
    console.error('ERROR: PAYSTACK_SECRET_KEY and PAYSTACK_PUBLIC_KEY must be set in .env');
    process.exit(1);
}

// Application Constants
const TOKEN_PRICE = parseFloat(process.env.TOKEN_PRICE) || 0.002;
const EXCHANGE_RATE = parseFloat(process.env.EXCHANGE_RATE) || 1460;
const ADMIN_SECRET_KEY = process.env.ADMIN_SECRET_KEY;

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

async function updateTransactionStatus(transactionId, status, metadata = {}) {
    try {
        const updateData = { status, updated_at: new Date().toISOString() };
        if (Object.keys(metadata).length > 0) {
            updateData.metadata = metadata;
        }
        
        const { data, error } = await supabase
            .from('transactions')
            .update(updateData)
            .eq('id', transactionId)
            .select()
            .single();
        
        if (error) throw error;
        return { success: true, data };
    } catch (error) {
        console.error('Error updating transaction:', error);
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

async function initiatePaystackTransfer(transferData) {
    try {
        const response = await axios.post(
            `${PAYSTACK_BASE_URL}/transfer`,
            transferData,
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
            throw new Error(data.message || 'Transfer initiation failed');
        }

        return {
            success: true,
            message: 'Transfer initiated successfully',
            data: data.data
        };
    } catch (error) {
        console.error('Paystack transfer error:', error.response?.data || error.message);
        throw new Error(error.response?.data?.message || 'Transfer initiation failed');
    }
}

async function createTransferRecipient(recipientData) {
    try {
        const response = await axios.post(
            `${PAYSTACK_BASE_URL}/transferrecipient`,
            recipientData,
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
            throw new Error(data.message || 'Recipient creation failed');
        }

        return {
            success: true,
            data: data.data
        };
    } catch (error) {
        console.error('Recipient creation error:', error.response?.data || error.message);
        throw new Error(error.response?.data?.message || 'Recipient creation failed');
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
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        service: 'SupremeAmer Payment API',
        version: '1.0.0'
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

        // Log successful payment
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
            message: 'Internal server error',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// Process withdrawal
app.post('/api/withdraw', async (req, res) => {
    try {
        const { userId, email, amount, amountFiat, currency, method, details } = req.body;

        // Validate required fields
        if (!userId || !email || !amount || !amountFiat || !currency || !method || !details) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields'
            });
        }

        // Validate amount
        if (amount <= 0 || amountFiat <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Invalid amount'
            });
        }

        // Check user's withdrawable balance
        const balance = await getUserBalance(userId);
        
        if (amount > balance.earnings) {
            return res.status(400).json({
                success: false,
                message: 'Insufficient earnings balance for withdrawal',
                currentBalance: balance.earnings,
                requestedAmount: amount
            });
        }

        // Validate withdrawal details based on method
        if (method === 'bank') {
            if (!details.bankName || !details.accountNumber || !details.accountName) {
                return res.status(400).json({
                    success: false,
                    message: 'Missing bank details'
                });
            }
        } else if (method === 'mobile_money') {
            if (!details.provider || !details.number) {
                return res.status(400).json({
                    success: false,
                    message: 'Missing mobile money details'
                });
            }
        } else {
            return res.status(400).json({
                success: false,
                message: 'Invalid withdrawal method'
            });
        }

        // Create withdrawal record
        const withdrawalData = {
            user_id: userId,
            amount: amount,
            amount_fiat: amountFiat,
            currency: currency,
            method: method,
            details: details,
            status: 'pending',
            date: new Date().toISOString(),
            email: email,
            user_email: email
        };

        const { data: withdrawal, error: withdrawalError } = await supabase
            .from('withdrawals')
            .insert(withdrawalData)
            .select()
            .single();

        if (withdrawalError) {
            throw withdrawalError;
        }

        // Create debit transaction
        const transactionData = {
            user_id: userId,
            type: 'withdrawal',
            amount: -amount,
            date: new Date().toISOString(),
            description: `Withdrawal request (${method}) - ${currency} ${currency === 'NGN' ? '₦' : '$'}${amountFiat}`,
            status: 'pending',
            withdrawal_id: withdrawal.id,
            metadata: { withdrawalDetails: details }
        };

        const transactionResult = await createTransaction(transactionData);
        
        if (!transactionResult.success) {
            // Rollback withdrawal if transaction fails
            await supabase
                .from('withdrawals')
                .delete()
                .eq('id', withdrawal.id);
            
            throw new Error(transactionResult.error);
        }

        // Update user balance immediately
        await supabase.rpc('update_user_balance', {
            user_id: userId,
            amount: -amount,
            balance_type: 'earnings'
        });

        // Initiate actual payout
        let transferResult;
        try {
            // First create transfer recipient
            const recipientType = method === 'bank' ? 'nuban' : 'mobile_money';
            const recipientData = {
                type: recipientType,
                name: details.accountName || details.name || email,
                account_number: details.accountNumber || details.number,
                bank_code: details.bankCode || (method === 'mobile_money' ? details.provider : undefined),
                currency: currency
            };

            const recipient = await createTransferRecipient(recipientData);
            
            // Then initiate transfer
            const transferData = {
                source: 'balance',
                amount: Math.round(amountFiat * 100), // Convert to smallest currency unit
                recipient: recipient.data.recipient_code,
                reason: `Withdrawal for ${email} - SupremeAmer`,
                currency: currency
            };

            transferResult = await initiatePaystackTransfer(transferData);
            
            // Update withdrawal with transfer details
            await supabase
                .from('withdrawals')
                .update({
                    status: 'processing',
                    transfer_code: transferResult.data.transfer_code,
                    transfer_data: transferResult.data,
                    recipient_code: recipient.data.recipient_code,
                    processed_at: new Date().toISOString()
                })
                .eq('id', withdrawal.id);

            // Update transaction status
            await updateTransactionStatus(transactionResult.data.id, 'processing', {
                transferCode: transferResult.data.transfer_code
            });

            console.log(`Withdrawal initiated: ${withdrawal.id}, User: ${userId}, Amount: ${amountFiat} ${currency}`);

            res.json({
                success: true,
                message: 'Withdrawal request submitted successfully. Processing may take 1-24 hours.',
                withdrawal: withdrawal,
                transaction: transactionResult.data,
                transfer: {
                    code: transferResult.data.transfer_code,
                    status: transferResult.data.status
                }
            });

        } catch (transferError) {
            // If transfer fails, update status but keep withdrawal record
            await supabase
                .from('withdrawals')
                .update({
                    status: 'failed',
                    failure_reason: transferError.message,
                    failed_at: new Date().toISOString()
                })
                .eq('id', withdrawal.id);

            await updateTransactionStatus(transactionResult.data.id, 'failed', {
                failureReason: transferError.message
            });

            // Refund tokens since transfer failed
            await supabase.rpc('update_user_balance', {
                user_id: userId,
                amount: amount,
                balance_type: 'earnings'
            });

            throw transferError;
        }

    } catch (error) {
        console.error('Withdrawal error:', error);
        res.status(500).json({
            success: false,
            message: 'Withdrawal processing failed',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Please contact support'
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

        if (advert.clicks >= advert.max_clicks) {
            return res.status(400).json({
                success: false,
                message: 'Advert click goal already reached'
            });
        }

        // Basic validation (in production, implement AI/ML verification here)
        const validationResult = {
            hasImage: !!proofUrl,
            fileType: 'image',
            timestamp: new Date().toISOString()
        };

        // For now, auto-approve all proofs (implement proper verification in production)
        const autoApprove = true;
        
        // If implementing AI verification:
        // const aiVerification = await aiVerifyProof(proofUrl, advert);
        // autoApprove = aiVerification.confidence > 0.8;

        res.json({
            success: true,
            verified: true,
            autoApprove: autoApprove,
            reason: autoApprove ? 'Proof verified successfully' : 'Proof requires manual review',
            validation: validationResult,
            rewardAmount: advert.reward_per_participant || 0
        });

    } catch (error) {
        console.error('Proof verification error:', error);
        res.status(500).json({
            success: false,
            message: 'Proof verification failed',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// Paystack Webhook Handler
app.post('/webhook/paystack', async (req, res) => {
    try {
        // Verify webhook signature
        if (!verifyPaystackSignature(req)) {
            console.error('Invalid webhook signature');
            return res.status(401).send('Invalid signature');
        }

        const event = req.body;
        console.log(`Paystack webhook received: ${event.event}`, {
            reference: event.data?.reference,
            amount: event.data?.amount,
            status: event.data?.status
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
                
            case 'transfer.reversed':
                await handleTransferReversed(event.data);
                break;
                
            default:
                console.log(`Unhandled webhook event: ${event.event}`);
        }

        res.sendStatus(200);
    } catch (error) {
        console.error('Webhook processing error:', error);
        res.status(500).send('Webhook processing failed');
    }
});

// Webhook handlers
async function handleChargeSuccess(data) {
    try {
        const reference = data.reference;
        
        // Check if this payment is already processed
        const { data: transaction } = await supabase
            .from('transactions')
            .select('*')
            .eq('payment_reference', reference)
            .single();

        if (!transaction) {
            // This might be a direct payment not from our system
            // Log it for investigation
            console.log(`Unrecognized successful charge: ${reference}`, {
                amount: data.amount,
                email: data.customer.email,
                channel: data.channel
            });
            
            await supabase
                .from('payment_logs')
                .insert({
                    reference: reference,
                    event: 'charge.success',
                    data: data,
                    status: 'unprocessed',
                    created_at: new Date().toISOString()
                });
        }
        
        // Update transaction if exists
        if (transaction && transaction.status !== 'completed') {
            await updateTransactionStatus(transaction.id, 'completed', {
                webhookProcessed: true,
                processedAt: new Date().toISOString()
            });
        }
        
    } catch (error) {
        console.error('Error handling charge success:', error);
    }
}

async function handleTransferSuccess(data) {
    try {
        const transferCode = data.transfer_code;
        
        // Find withdrawal
        const { data: withdrawal } = await supabase
            .from('withdrawals')
            .select('*')
            .eq('transfer_code', transferCode)
            .single();

        if (withdrawal) {
            // Update withdrawal status
            await supabase
                .from('withdrawals')
                .update({
                    status: 'completed',
                    completed_at: new Date().toISOString(),
                    transfer_data: data
                })
                .eq('id', withdrawal.id);

            // Update transaction status
            await supabase
                .from('transactions')
                .update({ 
                    status: 'completed',
                    metadata: { 
                        transferCompleted: true,
                        completedAt: new Date().toISOString()
                    }
                })
                .eq('withdrawal_id', withdrawal.id);

            // Send notification to user (implement email/SMS service)
            console.log(`Withdrawal completed: ${withdrawal.id}, User: ${withdrawal.user_id}, Amount: ${withdrawal.amount_fiat} ${withdrawal.currency}`);
        }
        
    } catch (error) {
        console.error('Error handling transfer success:', error);
    }
}

async function handleTransferFailed(data) {
    try {
        const transferCode = data.transfer_code;
        
        // Find withdrawal
        const { data: withdrawal } = await supabase
            .from('withdrawals')
            .select('*')
            .eq('transfer_code', transferCode)
            .single();

        if (withdrawal) {
            // Update withdrawal status
            await supabase
                .from('withdrawals')
                .update({
                    status: 'failed',
                    failed_at: new Date().toISOString(),
                    failure_reason: data.reason,
                    transfer_data: data
                })
                .eq('id', withdrawal.id);

            // Update transaction status
            await supabase
                .from('transactions')
                .update({ 
                    status: 'failed',
                    metadata: { 
                        transferFailed: true,
                        failureReason: data.reason,
                        failedAt: new Date().toISOString()
                    }
                })
                .eq('withdrawal_id', withdrawal.id);

            // Refund tokens to user
            await supabase.rpc('update_user_balance', {
                user_id: withdrawal.user_id,
                amount: withdrawal.amount,
                balance_type: 'earnings'
            });

            // Create refund transaction
            await createTransaction({
                user_id: withdrawal.user_id,
                type: 'refund',
                amount: withdrawal.amount,
                date: new Date().toISOString(),
                description: `Withdrawal refund - ${withdrawal.currency}`,
                status: 'completed',
                withdrawal_id: withdrawal.id,
                metadata: { originalWithdrawal: withdrawal.id }
            });

            console.log(`Withdrawal failed and refunded: ${withdrawal.id}, User: ${withdrawal.user_id}, Reason: ${data.reason}`);
        }
        
    } catch (error) {
        console.error('Error handling transfer failed:', error);
    }
}

async function handleTransferReversed(data) {
    try {
        const transferCode = data.transfer_code;
        
        // Find withdrawal
        const { data: withdrawal } = await supabase
            .from('withdrawals')
            .select('*')
            .eq('transfer_code', transferCode)
            .single();

        if (withdrawal) {
            // Update withdrawal status
            await supabase
                .from('withdrawals')
                .update({
                    status: 'reversed',
                    reversed_at: new Date().toISOString(),
                    reversal_reason: data.reason,
                    transfer_data: data
                })
                .eq('id', withdrawal.id);

            // Update transaction status
            await supabase
                .from('transactions')
                .update({ 
                    status: 'reversed',
                    metadata: { 
                        transferReversed: true,
                        reversalReason: data.reason,
                        reversedAt: new Date().toISOString()
                    }
                })
                .eq('withdrawal_id', withdrawal.id);

            // Refund tokens to user
            await supabase.rpc('update_user_balance', {
                user_id: withdrawal.user_id,
                amount: withdrawal.amount,
                balance_type: 'earnings'
            });

            console.log(`Withdrawal reversed: ${withdrawal.id}, User: ${withdrawal.user_id}, Reason: ${data.reason}`);
        }
        
    } catch (error) {
        console.error('Error handling transfer reversed:', error);
    }
}

// Admin Endpoints (protected)
app.use('/api/admin/', (req, res, next) => {
    const adminKey = req.headers['x-admin-key'];
    
    if (!adminKey || adminKey !== ADMIN_SECRET_KEY) {
        return res.status(401).json({
            success: false,
            message: 'Unauthorized'
        });
    }
    
    next();
});

// Admin: Get all pending withdrawals
app.get('/api/admin/withdrawals/pending', async (req, res) => {
    try {
        const { data: withdrawals, error } = await supabase
            .from('withdrawals')
            .select('*')
            .eq('status', 'pending')
            .order('date', { ascending: true });

        if (error) throw error;

        res.json({
            success: true,
            withdrawals: withdrawals || [],
            count: withdrawals?.length || 0
        });
    } catch (error) {
        console.error('Admin withdrawals error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch withdrawals'
        });
    }
});

// Admin: Process withdrawal manually
app.post('/api/admin/withdrawals/process', async (req, res) => {
    try {
        const { withdrawalId, force } = req.body;

        if (!withdrawalId) {
            return res.status(400).json({
                success: false,
                message: 'Withdrawal ID required'
            });
        }

        const { data: withdrawal } = await supabase
            .from('withdrawals')
            .select('*')
            .eq('id', withdrawalId)
            .single();

        if (!withdrawal) {
            return res.status(404).json({
                success: false,
                message: 'Withdrawal not found'
            });
        }

        if (withdrawal.status !== 'pending' && !force) {
            return res.status(400).json({
                success: false,
                message: `Withdrawal is already ${withdrawal.status}`
            });
        }

        // Process the withdrawal
        const recipientType = withdrawal.method === 'bank' ? 'nuban' : 'mobile_money';
        const recipientData = {
            type: recipientType,
            name: withdrawal.details.accountName || withdrawal.details.name || withdrawal.email,
            account_number: withdrawal.details.accountNumber || withdrawal.details.number,
            bank_code: withdrawal.details.bankCode || (withdrawal.method === 'mobile_money' ? withdrawal.details.provider : undefined),
            currency: withdrawal.currency
        };

        const recipient = await createTransferRecipient(recipientData);
        
        const transferData = {
            source: 'balance',
            amount: Math.round(withdrawal.amount_fiat * 100),
            recipient: recipient.data.recipient_code,
            reason: `Withdrawal for ${withdrawal.email} - SupremeAmer`,
            currency: withdrawal.currency
        };

        const transferResult = await initiatePaystackTransfer(transferData);

        // Update withdrawal
        await supabase
            .from('withdrawals')
            .update({
                status: 'processing',
                transfer_code: transferResult.data.transfer_code,
                transfer_data: transferResult.data,
                recipient_code: recipient.data.recipient_code,
                processed_at: new Date().toISOString(),
                processed_by: 'admin'
            })
            .eq('id', withdrawal.id);

        // Update transaction
        await supabase
            .from('transactions')
            .update({ 
                status: 'processing',
                metadata: { 
                    transferCode: transferResult.data.transfer_code,
                    processedBy: 'admin',
                    processedAt: new Date().toISOString()
                }
            })
            .eq('withdrawal_id', withdrawal.id);

        res.json({
            success: true,
            message: 'Withdrawal processing initiated',
            withdrawal: withdrawal,
            transfer: {
                code: transferResult.data.transfer_code,
                status: transferResult.data.status
            }
        });

    } catch (error) {
        console.error('Admin withdrawal processing error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to process withdrawal',
            error: error.message
        });
    }
});

// Admin: Get payment statistics
app.get('/api/admin/stats', async (req, res) => {
    try {
        const { period = 'today' } = req.query;
        
        let startDate = new Date();
        let endDate = new Date();
        
        switch (period) {
            case 'today':
                startDate.setHours(0, 0, 0, 0);
                break;
            case 'week':
                startDate.setDate(startDate.getDate() - 7);
                break;
            case 'month':
                startDate.setMonth(startDate.getMonth() - 1);
                break;
            case 'year':
                startDate.setFullYear(startDate.getFullYear() - 1);
                break;
        }

        // Get transactions
        const { data: transactions } = await supabase
            .from('transactions')
            .select('*')
            .gte('date', startDate.toISOString())
            .lte('date', endDate.toISOString());

        // Get withdrawals
        const { data: withdrawals } = await supabase
            .from('withdrawals')
            .select('*')
            .gte('date', startDate.toISOString())
            .lte('date', endDate.toISOString());

        // Calculate stats
        const stats = {
            period: period,
            startDate: startDate.toISOString(),
            endDate: endDate.toISOString(),
            totalTransactions: transactions?.length || 0,
            totalWithdrawals: withdrawals?.length || 0,
            totalVolume: 0,
            totalWithdrawalVolume: 0,
            topups: 0,
            earnings: 0,
            withdrawals: 0,
            byType: {},
            byStatus: {}
        };

        if (transactions) {
            transactions.forEach(tx => {
                const amount = parseFloat(tx.amount) || 0;
                stats.totalVolume += Math.abs(amount);
                
                if (!stats.byType[tx.type]) stats.byType[tx.type] = 0;
                stats.byType[tx.type] += Math.abs(amount);
                
                if (!stats.byStatus[tx.status]) stats.byStatus[tx.status] = 0;
                stats.byStatus[tx.status]++;
                
                if (tx.type === 'topup') {
                    stats.topups += amount;
                } else if (tx.type === 'withdrawal') {
                    stats.withdrawals += Math.abs(amount);
                } else if (['credit', 'referral', 'daily_reward', 'ad_reward'].includes(tx.type)) {
                    stats.earnings += amount;
                }
            });
        }

        if (withdrawals) {
            withdrawals.forEach(wd => {
                stats.totalWithdrawalVolume += parseFloat(wd.amount_fiat) || 0;
            });
        }

        res.json({
            success: true,
            stats: stats
        });

    } catch (error) {
        console.error('Admin stats error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch statistics'
        });
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    
    res.status(500).json({
        success: false,
        message: 'Internal server error',
        ...(process.env.NODE_ENV === 'development' && { error: err.message, stack: err.stack })
    });
});

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({
        success: false,
        message: 'Endpoint not found'
    });
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received. Shutting down gracefully...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('SIGINT received. Shutting down gracefully...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

// Start server
const server = app.listen(PORT, () => {
    console.log(`🚀 SupremeAmer Payment API running on port ${PORT}`);
    console.log(`📊 Supabase: ${supabaseUrl}`);
    console.log(`💳 Paystack: ${PAYSTACK_BASE_URL}`);
    console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`⏰ Started at: ${new Date().toISOString()}`);
});

module.exports = app;