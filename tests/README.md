# Tests Directory

This directory contains all tests for the Web Page Downloader Chrome extension.

## Directory Structure

```
tests/
├── e2e/                          # End-to-End tests (Puppeteer)
│   ├── extension-installation.test.cjs
│   ├── README.md
│   ├── screenshots/              # Auto-generated (gitignored)
│   └── downloads/                # Test downloads (gitignored)
└── unit/                         # Unit tests (to be added)
    └── (your unit tests here)
```

## Test Types

### E2E Tests (`tests/e2e/`)

End-to-end tests using **Puppeteer** to test the extension in a real Chrome browser.

**Run E2E tests:**
```bash
npm run test:e2e              # Headed mode (browser visible)
npm run test:e2e:headless     # Headless mode (no browser window)
```

**What they test:**
- Extension installation and activation
- Extension UI accessibility
- Extension permissions
- Full user workflows

**See:** `tests/e2e/README.md` for detailed documentation

### Unit Tests (`tests/unit/`)

Unit tests for individual functions and components (to be added).

**Planned frameworks:**
- Jest for JavaScript/TypeScript unit tests
- React Testing Library for component tests

**Future commands:**
```bash
npm run test:unit             # Run unit tests
npm run test:unit:watch       # Run in watch mode
npm run test:unit:coverage    # Generate coverage report
```

## Quick Start

### Run all E2E tests
```bash
# Build extension first
npm run build

# Run tests
npm run test:e2e:headless
```

### Run specific test
```bash
node tests/e2e/extension-installation.test.cjs
```

## Test Results

E2E tests generate:
- **Screenshots** in `tests/e2e/screenshots/`
- **Console output** with colored test results
- **Exit codes** (0 = success, 1 = failure)

## Adding New Tests

### Adding E2E Tests

1. Create a new test file in `tests/e2e/`:
   ```bash
   touch tests/e2e/my-feature.test.cjs
   ```

2. Follow the pattern from `extension-installation.test.cjs`

3. Add a script to `package.json`:
   ```json
   "test:e2e:my-feature": "node tests/e2e/my-feature.test.cjs"
   ```

### Adding Unit Tests

1. Create test files in `tests/unit/`:
   ```bash
   mkdir -p tests/unit/components
   touch tests/unit/components/MyComponent.test.ts
   ```

2. Install Jest if not already installed:
   ```bash
   npm install --save-dev jest @types/jest
   ```

3. Configure Jest in `package.json` or `jest.config.js`

4. Add test scripts:
   ```json
   "test:unit": "jest",
   "test:unit:watch": "jest --watch"
   ```

## CI/CD Integration

For continuous integration, use headless mode:

```yaml
# Example GitHub Actions
- name: Run E2E Tests
  run: |
    npm run build
    npm run test:e2e:headless

- name: Run Unit Tests
  run: npm run test:unit
```

## Documentation

- **E2E Tests**: See `tests/e2e/README.md`
- **Unit Tests**: (Documentation to be added)

## Current Status

- ✅ **E2E Tests**: Fully set up with Puppeteer
  - 4/4 tests passing
  - Extension installation verified
  - Screenshots working
  
- ⏳ **Unit Tests**: To be implemented
  - Directory structure ready
  - Awaiting test implementation
