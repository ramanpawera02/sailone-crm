// Authentication helpers: JWT issuing + route protection middleware.
const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'dev_insecure_secret_change_me';

function sign(user) {
  return jwt.sign({ id: user.id, email: user.email, name: user.name }, SECRET, {
    expiresIn: '7d',
  });
}

// Reads token from httpOnly cookie or Authorization header.
function requireAuth(req, res, next) {
  const bearer = req.headers.authorization?.replace('Bearer ', '');
  const token = req.cookies?.token || bearer;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired session' });
  }
}

module.exports = { sign, requireAuth };
