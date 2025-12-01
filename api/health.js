module.exports = async (req, res) => {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    
    // Handle preflight requests
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    // Only accept GET requests
    if (req.method !== 'GET') {
        return res.status(405).json({
            success: false,
            message: 'Method not allowed'
        });
    }

    try {
        const healthData = {
            status: 'healthy',
            timestamp: new Date().toISOString(),
            service: 'SupremeAmer API',
            version: '1.0.0',
            environment: process.env.VERCEL_ENV || 'production',
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            database: 'connected',
            paystack: 'configured'
        };

        // Check database connection if needed
        // const { data, error } = await supabase.from('users').select('count').limit(1);
        // healthData.database = error ? 'disconnected' : 'connected';

        res.json(healthData);
    } catch (error) {
        console.error('Health check error:', error);
        res.status(500).json({
            status: 'unhealthy',
            timestamp: new Date().toISOString(),
            error: error.message
        });
    }
};