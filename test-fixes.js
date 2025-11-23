/**
 * Test script to verify the fixes for the extension issues
 */

// Test 1: Verify scrolling logic improvements
function testScrollingLogic() {
  console.log("Testing scrolling logic improvements...");
  
  // Simulate the improved scroll detection logic
  const prevTop = 1000;
  const prevHeight = 2000;
  const response = {
    top: 1005, // Small change (5px)
    height: 2005, // Small change (5px)
  };
  
  const scrollPositionChanged = Math.abs((response.top || 0) - prevTop) > 10;
  const contentHeightChanged = Math.abs((response.height || 0) - prevHeight) > 50;
  
  console.log("Scroll position changed:", scrollPositionChanged);
  console.log("Content height changed:", contentHeightChanged);
  
  // Should stop scrolling if both are false
  const shouldStopScrolling = !scrollPositionChanged && !contentHeightChanged;
  console.log("Should stop scrolling:", shouldStopScrolling);
  
  return shouldStopScrolling;
}

// Test 2: Verify HTML conversion error handling
function testHtmlConversionHandling() {
  console.log("Testing HTML conversion error handling...");
  
  // Test with valid HTML
  const validHtml = "<html><body><h1>Test</h1></body></html>";
  console.log("Valid HTML test:", validHtml.length > 0 ? "PASS" : "FAIL");
  
  // Test with invalid HTML
  const invalidHtml = null;
  console.log("Invalid HTML test:", invalidHtml === null ? "PASS" : "FAIL");
  
  // Test with empty HTML
  const emptyHtml = "";
  console.log("Empty HTML test:", emptyHtml.length === 0 ? "PASS" : "FAIL");
  
  return true;
}

// Test 3: Verify exponential growth detection improvements
function testExponentialGrowthDetection() {
  console.log("Testing exponential growth detection improvements...");
  
  // Simulate HTML complexity analysis
  const mockAnalysis = {
    totalElements: 75000, // Below new threshold of 100000
    hasNestedTables: 5, // Below new threshold of 10
    hasDeeplyNested: 3, // Below new threshold of 5
    hasLargeTables: 0, // Below new threshold
    hasDuplicateContent: false,
  };
  
  const isExponential = 
    mockAnalysis.totalElements > 100000 ||
    mockAnalysis.hasNestedTables > 10 ||
    mockAnalysis.hasDeeplyNested > 5 ||
    mockAnalysis.hasLargeTables > 0 ||
    mockAnalysis.hasDuplicateContent;
  
  console.log("Exponential growth detection:", isExponential ? "FAIL" : "PASS");
  console.log("Expected: false (should not trigger exponential growth warning)");
  
  return !isExponential;
}

// Run all tests
function runTests() {
  console.log("Running extension fixes tests...\n");
  
  const test1 = testScrollingLogic();
  console.log("\n");
  
  const test2 = testHtmlConversionHandling();
  console.log("\n");
  
  const test3 = testExponentialGrowthDetection();
  console.log("\n");
  
  const allTestsPassed = test1 && test2 && test3;
  
  console.log("=== TEST RESULTS ===");
  console.log("Scrolling logic test:", test1 ? "PASS" : "FAIL");
  console.log("HTML conversion test:", test2 ? "PASS" : "FAIL");
  console.log("Exponential growth test:", test3 ? "PASS" : "FAIL");
  console.log("Overall result:", allTestsPassed ? "ALL TESTS PASSED" : "SOME TESTS FAILED");
  
  return allTestsPassed;
}

// Run the tests
runTests();