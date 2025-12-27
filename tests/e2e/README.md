# Puppeteer E2E Tests for Chrome Extension

## Overview

This directory contains end-to-end tests for the Web Page Downloader Chrome extension using Puppeteer. Unlike Selenium/ChromeDriver, Puppeteer has excellent support for loading and testing Chrome extensions.

## Why Puppeteer?

Puppeteer was chosen over Nightwatch.js/Selenium because:
- ✅ **Native extension support** - Extensions load properly in automated tests
- ✅ **Better Chrome integration** - Built by the Chrome team
- ✅ **Simpler setup** - No separate WebDriver needed
- ✅ **More reliable** - Fewer flaky tests
- ✅ **Better debugging** - Can run in headed mode easily

## Setup

### Prerequisites

- Node.js and npm installed
- Chrome browser (Puppeteer will download Chromium automatically)
- Extension built in the `dist/` directory

### Installation

Puppeteer is already installed via the main `package.json`:

```bash
npm install
```

## Running Tests

### Build the extension first
```bash
npm run build
```

### Run tests (headed mode - browser visible)
```bash
npm run test:e2e
```

This will:
- Launch Chrome with the extension loaded
- Run all tests
- Take screenshots at each step
- Keep the browser open for inspection
- Show detailed test results in the console

### Run tests (headless mode - no browser window)
```bash
npm run test:e2e:headless
```

This will:
- Run tests in headless Chrome
- Take screenshots at each step
- Close the browser automatically
- Exit with code 0 (success) or 1 (failure)

## Test Structure

```
tests/
├── extension-installation.test.js  # Main test file
├── screenshots/                     # Screenshots from test runs (gitignored)
└── downloads/                       # Downloaded files during tests (gitignored)
```

## What the Test Checks

The `extension-installation.test.js` file runs 4 comprehensive tests:

### TEST 1: Accessing chrome://extensions page
- Navigates to the extensions management page
- Verifies the page loads successfully
- Takes a screenshot

### TEST 2: Finding the extension
- Enables developer mode
- Searches for "Web Page Downloader" extension
- Verifies the extension is installed
- Checks if the extension is enabled
- Displays extension details (ID, name, status)
- Lists all installed extensions for debugging

### TEST 3: Accessing extension side panel
- Constructs the extension URL using the discovered extension ID
- Navigates to `chrome-extension://{id}/sidePanel.html`
- Verifies the page loads without errors
- Checks that the extension UI is accessible

### TEST 4: Verifying extension permissions
- Opens the extension details page
- Verifies access to extension configuration
- Takes a screenshot of the details page

## Test Output

The test provides colorful, detailed console output:

```
🚀 Starting Puppeteer E2E Tests for Chrome Extension

ℹ️  Extension path: /path/to/dist
ℹ️  Headless mode: false
ℹ️  Screenshots directory: /path/to/screenshots

🌐 Launching Chrome with extension...
✅ Browser launched successfully

📋 TEST 1: Accessing chrome://extensions page
✅ Successfully navigated to chrome://extensions

📋 TEST 2: Finding extension in chrome://extensions
📦 Extension Details:
   Name: Web Page Downloader
   ID: aeojmgngnebhbjpncamiplkimkbnmpmk
   Status: Enabled ✅
✅ Extension is installed and enabled

📋 TEST 3: Accessing extension side panel
✅ Extension side panel is accessible

📋 TEST 4: Verifying extension has required permissions
✅ Extension details page accessible

============================================================
📊 TEST SUMMARY
============================================================
✅ Tests Passed: 4
Tests Failed: 0
Total Tests: 4
============================================================

🎉 All tests passed! Extension is properly installed and activated.
```

## Screenshots

Screenshots are automatically saved to `tests/screenshots/` after each test step:

- `01-extensions-page.png` - The chrome://extensions page
- `02-extension-found.png` - Extension visible in the list
- `03-extension-panel.png` - Extension side panel loaded
- `04-extension-details.png` - Extension details page

## Debugging

### Run in headed mode (default)
```bash
npm run test:e2e
```

The browser will stay open after tests complete, allowing you to:
- Inspect the extension
- Check the console for errors
- Manually interact with the extension
- Close the browser when done

### View screenshots
All screenshots are saved in `tests/screenshots/` directory. Check these if tests fail to see what the browser was showing.

### Verbose output
The test already provides detailed logging. Check the console output for:
- Extension ID
- Extension status
- All installed extensions
- Page URLs and content
- Error messages

## Common Issues

### Extension not found
**Problem**: Test reports 0 extensions found

**Solution**:
1. Ensure extension is built: `npm run build`
2. Check that `dist/manifest.json` exists
3. Verify the extension name in manifest matches "Web Page Downloader"

### Extension blocked or shows error
**Problem**: Extension URL shows "blocked" or error page

**Solution**:
1. Check manifest.json for errors
2. Ensure all required files are in dist/
3. Check browser console for extension errors

### Puppeteer installation issues
**Problem**: Puppeteer fails to install or download Chromium

**Solution**:
```bash
# Clear npm cache and reinstall
npm cache clean --force
rm -rf node_modules package-lock.json
npm install
```

### Tests timeout
**Problem**: Tests hang or timeout

**Solution**:
1. Increase timeout in the test file (currently 10000ms)
2. Check if extension has errors preventing it from loading
3. Run in headed mode to see what's happening

## Writing Additional Tests

To add more tests, you can:

1. **Add tests to the existing file**:
   ```javascript
   // TEST 5: Your new test
   log('\n📋 TEST 5: Testing something else', 'yellow');
   try {
     // Your test code here
     logSuccess('Test passed');
     testsPassed++;
   } catch (error) {
     logError(`Test failed: ${error.message}`);
     testsFailed++;
   }
   ```

2. **Create a new test file**:
   - Copy `extension-installation.test.js`
   - Modify the tests
   - Add a new script to `package.json`

3. **Use the extension in tests**:
   ```javascript
   // Navigate to a test page
   await page.goto('https://example.com');
   
   // Interact with the extension
   // (Extension should be active on the page)
   
   // Test extension functionality
   ```

## CI/CD Integration

For continuous integration, use headless mode:

```yaml
# Example GitHub Actions
- name: Build extension
  run: npm run build

- name: Run E2E tests
  run: npm run test:e2e:headless
```

The test will exit with:
- **Exit code 0** if all tests pass
- **Exit code 1** if any test fails

## Next Steps

Potential improvements:
- [ ] Add tests for extension functionality (downloading pages)
- [ ] Test extension on different websites
- [ ] Add performance testing
- [ ] Test extension updates
- [ ] Add visual regression testing
- [ ] Test extension permissions flow
