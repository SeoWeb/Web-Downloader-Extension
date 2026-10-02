# Unit Tests

This directory is reserved for unit tests.

## Setup (To Do)

1. Install Jest and testing utilities:
   ```bash
   npm install --save-dev jest @types/jest ts-jest
   npm install --save-dev @testing-library/react @testing-library/jest-dom
   ```

2. Create `jest.config.js` in the project root

3. Add test scripts to `package.json`:
   ```json
   "test:unit": "jest",
   "test:unit:watch": "jest --watch",
   "test:unit:coverage": "jest --coverage"
   ```

## Example Test Structure

```
tests/unit/
├── components/
│   ├── Filter.test.tsx
│   ├── ChromeExtensionRating.test.tsx
│   └── GlobalPermissionRequest.test.tsx
├── utils/
│   ├── blobStorage.test.ts
│   └── downloadManager.test.ts
└── hooks/
    └── useGlobalUserId.test.ts
```

## Writing Tests

Example component test:

```typescript
import { render, screen } from '@testing-library/react';
import { MyComponent } from '../../src/components/MyComponent';

describe('MyComponent', () => {
  it('should render correctly', () => {
    render(<MyComponent />);
    expect(screen.getByText('Expected Text')).toBeInTheDocument();
  });
});
```

Example utility test:

```typescript
import { myUtilFunction } from '../../src/utils/myUtil';

describe('myUtilFunction', () => {
  it('should return expected result', () => {
    expect(myUtilFunction('input')).toBe('expected output');
  });
});
```

## Running Tests

Once set up:

```bash
# Run all unit tests
npm run test:unit

# Run in watch mode
npm run test:unit:watch

# Generate coverage report
npm run test:unit:coverage
```
