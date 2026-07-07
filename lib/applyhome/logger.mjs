// Lightweight console logger (replaces the Express-era winston setup).
// Runs inside the Vite dev middleware / Vercel function — no file transports.
const ts = () => new Date().toISOString();

const logger = {
  info: (...args) => console.log(`${ts()} [INFO]:`, ...args),
  warn: (...args) => console.warn(`${ts()} [WARN]:`, ...args),
  error: (...args) => console.error(`${ts()} [ERROR]:`, ...args),
};

export default logger;
