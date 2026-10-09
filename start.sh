#!/usr/bin/env bash
# Quickstart script for WhatsApp AI Doctor Scheduling Agent

echo "=========================================================="
echo "⚕️  WhatsApp AI Scheduling Agent & Clinic Hub"
echo "=========================================================="

# Check if node is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 18+ first."
    exit 1
fi

echo "📦 Checking and installing dependencies..."
npm install

echo "🚀 Starting server..."
node src/server.js
