#!/bin/bash

# Quick test runner script
# This script runs the E2E tests and shows a summary

echo "🧪 Running Chrome Extension E2E Tests..."
echo ""

# Build the extension first
echo "📦 Building extension..."
npm run build

echo ""
echo "🚀 Running tests in headless mode..."
echo ""

# Run tests
npm run test:e2e:headless

# Check exit code
if [ $? -eq 0 ]; then
    echo ""
    echo "✅ All tests passed!"
    echo ""
    echo "📸 Screenshots saved to: tests/screenshots/"
    ls -lh tests/screenshots/
else
    echo ""
    echo "❌ Tests failed. Check output above for details."
    exit 1
fi
