// Main entry point for WhatsApp Doctor Scheduling Agent
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

process.on('uncaughtException', (err) => {
  console.error('🔥 UNCAUGHT EXCEPTION:', err.stack || err.message || err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🔥 UNHANDLED REJECTION:', reason);
});

// Self-healing: If platform build step was skipped and express is missing, run npm install
const expressModulePath = path.join(__dirname, 'node_modules', 'express');
if (!fs.existsSync(expressModulePath)) {
  console.log('⚡ [Auto-Install] node_modules not detected. Installing dependencies now...');
  try {
    execSync('npm install --omit=dev', { stdio: 'inherit', cwd: __dirname });
    console.log('✅ [Auto-Install] Dependencies installed successfully.');
  } catch (err) {
    console.error('⚠️ [Auto-Install] Failed to run automatic npm install:', err.message);
  }
}

// Cloud PaaS keep-alive (guarantees event loop stays active for web services)
setInterval(() => {}, 1000 * 60 * 60);

// Smart Server Discovery: Finds server.js wherever it is located in the repository
function resolveServerPath() {
  const candidates = [
    path.join(__dirname, 'src', 'server.js'),
    path.join(__dirname, 'whatsapp-doctor-agent', 'src', 'server.js'),
    path.join(__dirname, 'server.js'),
    path.join(process.cwd(), 'src', 'server.js'),
    path.join(process.cwd(), 'whatsapp-doctor-agent', 'src', 'server.js')
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return c;
    }
  }

  // Recursive search if not found in standard paths
  function search(dir, depth = 0) {
    if (depth > 3) return null;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
          const sub = path.join(dir, entry.name);
          const target = path.join(sub, 'server.js');
          if (fs.existsSync(target)) return target;
          const found = search(sub, depth + 1);
          if (found) return found;
        }
      }
    } catch (e) {}
    return null;
  }

  return search(__dirname) || search(process.cwd());
}

const serverFile = resolveServerPath();
if (serverFile) {
  console.log(`🚀 [Server Bootstrap] Starting server from: ${serverFile}`);
  require(serverFile);
} else {
  console.error('❌ [Server Bootstrap] Could not locate server.js. Directory contents:');
  try {
    console.error('Root Directory:', fs.readdirSync(__dirname));
  } catch (e) {}
}
