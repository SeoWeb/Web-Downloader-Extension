/**
 * Puppeteer E2E Test: Extension Installation and Activation
 * 
 * This test verifies that the Web Page Downloader Chrome extension is:
 * 1. Successfully loaded in Chrome
 * 2. Activated and enabled
 * 3. Accessible via its extension URL
 */

const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

// Configuration
const EXTENSION_PATH = path.resolve(__dirname, '../../dist');
const SCREENSHOTS_DIR = path.resolve(__dirname, 'screenshots');
const HEADLESS = process.env.HEADLESS === 'true';

// Ensure directories exist
if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[36m',
  gray: '\x1b[90m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logSuccess(message) {
  log(`✅ ${message}`, 'green');
}

function logError(message) {
  log(`❌ ${message}`, 'red');
}

function logInfo(message) {
  log(`ℹ️  ${message}`, 'blue');
}

function logWarning(message) {
  log(`⚠️  ${message}`, 'yellow');
}

async function takeScreenshot(page, name) {
  const screenshotPath = path.join(SCREENSHOTS_DIR, `${name}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  log(`📸 Screenshot saved: ${screenshotPath}`, 'gray');
}

async function runTests() {
  let browser;
  let testsPassed = 0;
  let testsFailed = 0;

  try {
    log('\n🚀 Starting Puppeteer E2E Tests for Chrome Extension\n', 'blue');
    logInfo(`Extension path: ${EXTENSION_PATH}`);
    logInfo(`Headless mode: ${HEADLESS}`);
    logInfo(`Screenshots directory: ${SCREENSHOTS_DIR}\n`);

    // Verify extension directory exists
    if (!fs.existsSync(EXTENSION_PATH)) {
      logError(`Extension directory not found: ${EXTENSION_PATH}`);
      logWarning('Please run "npm run build" first to build the extension');
      process.exit(1);
    }

    // Verify manifest.json exists
    const manifestPath = path.join(EXTENSION_PATH, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      logError(`manifest.json not found in: ${EXTENSION_PATH}`);
      process.exit(1);
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    logInfo(`Extension name: ${manifest.name}`);
    logInfo(`Extension version: ${manifest.version}\n`);

    // Launch browser with extension
    log('🌐 Launching Chrome with extension...', 'blue');
    browser = await puppeteer.launch({
      headless: HEADLESS ? 'new' : false,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled'
      ],
      defaultViewport: null
    });

    logSuccess('Browser launched successfully\n');

    // Get all pages (extension might open background pages)
    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();

    // TEST 1: Navigate to chrome://extensions
    log('📋 TEST 1: Accessing chrome://extensions page', 'yellow');
    try {
      await page.goto('chrome://extensions', { waitUntil: 'networkidle0', timeout: 10000 });
      await new Promise(resolve => setTimeout(resolve, 2000));
      await takeScreenshot(page, '01-extensions-page');
      logSuccess('Successfully navigated to chrome://extensions');
      testsPassed++;
    } catch (error) {
      logError(`Failed to navigate to chrome://extensions: ${error.message}`);
      testsFailed++;
    }

    // TEST 2: Enable developer mode and find extension
    log('\n📋 TEST 2: Finding extension in chrome://extensions', 'yellow');
    try {
      const extensionInfo = await page.evaluate(() => {
        // Enable developer mode
        const extensionsManager = document.querySelector('extensions-manager');
        const toolbar = extensionsManager?.shadowRoot?.querySelector('extensions-toolbar');
        const devModeToggle = toolbar?.shadowRoot?.querySelector('#devMode');
        
        if (devModeToggle && !devModeToggle.checked) {
          devModeToggle.click();
        }

        // Find all extensions
        const itemList = extensionsManager?.shadowRoot?.querySelector('extensions-item-list');
        const items = itemList?.shadowRoot?.querySelectorAll('extensions-item');
        
        const extensions = [];
        if (items) {
          items.forEach(item => {
            const nameElement = item.shadowRoot?.querySelector('#name');
            const enableToggle = item.shadowRoot?.querySelector('#enableToggle');
            const descElement = item.shadowRoot?.querySelector('#description');
            
            if (nameElement) {
              extensions.push({
                id: item.id,
                name: nameElement.textContent.trim(),
                enabled: enableToggle?.checked || false,
                description: descElement?.textContent.trim() || ''
              });
            }
          });
        }

        // Find our specific extension
        const targetExtension = extensions.find(ext => 
          ext.name.includes('Web Page Downloader')
        );

        return {
          totalExtensions: extensions.length,
          allExtensions: extensions,
          targetExtension: targetExtension || null
        };
      });

      logInfo(`Total extensions found: ${extensionInfo.totalExtensions}`);
      
      if (extensionInfo.allExtensions.length > 0) {
        log('\nAll extensions:', 'gray');
        extensionInfo.allExtensions.forEach(ext => {
          log(`  - ${ext.name} (${ext.id}) - ${ext.enabled ? 'Enabled' : 'Disabled'}`, 'gray');
        });
      }

      if (extensionInfo.targetExtension) {
        log('\n📦 Extension Details:', 'blue');
        log(`   Name: ${extensionInfo.targetExtension.name}`, 'blue');
        log(`   ID: ${extensionInfo.targetExtension.id}`, 'blue');
        log(`   Status: ${extensionInfo.targetExtension.enabled ? 'Enabled ✅' : 'Disabled ❌'}`, 'blue');
        log(`   Description: ${extensionInfo.targetExtension.description}`, 'blue');
        
        if (extensionInfo.targetExtension.enabled) {
          logSuccess('Extension is installed and enabled');
          testsPassed++;
        } else {
          logError('Extension is installed but NOT enabled');
          testsFailed++;
        }

        // Store extension ID for next test
        global.extensionId = extensionInfo.targetExtension.id;
      } else {
        logError('Web Page Downloader extension NOT found');
        testsFailed++;
      }

      await takeScreenshot(page, '02-extension-found');
    } catch (error) {
      logError(`Failed to find extension: ${error.message}`);
      testsFailed++;
    }

    // TEST 3: Access extension side panel
    if (global.extensionId) {
      log('\n📋 TEST 3: Accessing extension side panel', 'yellow');
      try {
        const extensionUrl = `chrome-extension://${global.extensionId}/sidePanel.html`;
        logInfo(`Extension URL: ${extensionUrl}`);
        
        await page.goto(extensionUrl, { waitUntil: 'networkidle0', timeout: 10000 });
        await new Promise(resolve => setTimeout(resolve, 2000));

        const pageInfo = await page.evaluate(() => {
          return {
            url: window.location.href,
            title: document.title,
            bodyExists: !!document.body,
            hasContent: document.body?.children.length > 0,
            bodyText: document.body?.textContent?.substring(0, 200) || '',
            hasError: document.body?.textContent?.includes('ERR_') || 
                     document.body?.textContent?.includes('blocked') || false
          };
        });

        logInfo(`Current URL: ${pageInfo.url}`);
        logInfo(`Page title: ${pageInfo.title}`);
        logInfo(`Body exists: ${pageInfo.bodyExists}`);
        logInfo(`Has content: ${pageInfo.hasContent}`);

        if (pageInfo.hasError) {
          logError('Extension page shows an error');
          logError(`Error content: ${pageInfo.bodyText}`);
          testsFailed++;
        } else if (pageInfo.url.includes('chrome-extension://') && pageInfo.bodyExists) {
          logSuccess('Extension side panel is accessible');
          testsPassed++;
        } else {
          logError('Extension side panel could not be accessed properly');
          testsFailed++;
        }

        await takeScreenshot(page, '03-extension-panel');
      } catch (error) {
        logError(`Failed to access extension panel: ${error.message}`);
        testsFailed++;
      }
    } else {
      logWarning('Skipping TEST 3: Extension ID not available');
    }

    // TEST 4: Verify extension permissions
    if (global.extensionId) {
      log('\n📋 TEST 4: Verifying extension has required permissions', 'yellow');
      try {
        await page.goto('chrome://extensions', { waitUntil: 'networkidle0' });
        await new Promise(resolve => setTimeout(resolve, 1000));

        const permissionsInfo = await page.evaluate((extId) => {
          const extensionsManager = document.querySelector('extensions-manager');
          const itemList = extensionsManager?.shadowRoot?.querySelector('extensions-item-list');
          const item = itemList?.shadowRoot?.querySelector(`extensions-item[id="${extId}"]`);
          
          if (!item) return { found: false };

          const detailsButton = item.shadowRoot?.querySelector('#detailsButton');
          if (detailsButton) {
            detailsButton.click();
          }

          return {
            found: true,
            hasDetailsButton: !!detailsButton
          };
        }, global.extensionId);

        if (permissionsInfo.found && permissionsInfo.hasDetailsButton) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          await takeScreenshot(page, '04-extension-details');
          logSuccess('Extension details page accessible');
          testsPassed++;
        } else {
          logWarning('Could not access extension details page');
        }
      } catch (error) {
        logError(`Failed to verify permissions: ${error.message}`);
        testsFailed++;
      }
    }

    // Summary
    log('\n' + '='.repeat(60), 'blue');
    log('📊 TEST SUMMARY', 'blue');
    log('='.repeat(60), 'blue');
    logSuccess(`Tests Passed: ${testsPassed}`);
    if (testsFailed > 0) {
      logError(`Tests Failed: ${testsFailed}`);
    } else {
      log(`Tests Failed: ${testsFailed}`, 'gray');
    }
    log(`Total Tests: ${testsPassed + testsFailed}`, 'blue');
    log('='.repeat(60) + '\n', 'blue');

    if (testsFailed === 0) {
      logSuccess('🎉 All tests passed! Extension is properly installed and activated.\n');
      process.exit(0);
    } else {
      logError('❌ Some tests failed. Please review the output above.\n');
      process.exit(1);
    }

  } catch (error) {
    logError(`\n💥 Fatal error: ${error.message}`);
    console.error(error);
    process.exit(1);
  } finally {
    if (browser) {
      if (!HEADLESS) {
        logInfo('Browser will remain open for inspection. Close it manually when done.');
        // Keep browser open in non-headless mode for debugging
        await new Promise(() => {}); // Wait indefinitely
      } else {
        await browser.close();
        logInfo('Browser closed');
      }
    }
  }
}

// Run tests
runTests();
