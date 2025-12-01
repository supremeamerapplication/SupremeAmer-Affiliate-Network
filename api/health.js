export default function handler(req, res) {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'SupremeAmer API',
    version: '1.0.0'
  });
}