# Resource Management Specification

## Purpose

Resource fetching, memory management, request queuing, throttling, and domain rate limiting for the Website Downloader extension. Covers how network requests are managed efficiently while respecting memory constraints and server rate limits.

## Requirements

### Requirement: URL Resolution and Fetching

The system SHALL resolve relative URLs and fetch resources with retry logic and timeout handling.

#### Scenario: Successful resource fetch

- GIVEN a valid resource URL and a base URL
- WHEN the resource is fetched
- THEN the full URL is resolved against the base URL
- AND the resource is downloaded with appropriate User-Agent, Accept, Referer, and Origin headers
- AND the response is returned

#### Scenario: Resource fetch with retry on transient failure

- GIVEN a resource URL that fails with a server error (5xx) or timeout
- WHEN the fetch is retried up to 3 times
- THEN exponential backoff is applied between retries
- AND the retry succeeds if the transient error resolves

#### Scenario: Resource fetch with permanent failure

- GIVEN a resource URL that returns a permanent client error (4xx, except 408 and 429)
- WHEN the fetch fails
- THEN no retry is attempted
- AND null is returned

#### Scenario: Resource fetch timeout

- GIVEN a resource URL with a configurable timeout (default 30 seconds)
- WHEN the fetch takes longer than the timeout
- THEN the request is aborted
- AND a retry is attempted if retries remain

#### Scenario: Resource size limit check

- GIVEN a resource response with a Content-Length header
- AND the content length exceeds the size limit for that resource type
- WHEN the size check is performed
- THEN the download is skipped and null is returned

#### Scenario: Resource type size limits

- GIVEN the following per-type limits: images 20MB, CSS 5MB, JS 10MB, HTML 10MB, PDF 25MB, video 100MB, audio 50MB, default 10MB
- WHEN a resource is evaluated
- THEN the appropriate limit is applied based on the resource type

### Requirement: Memory Pressure Levels

The system SHALL monitor memory usage and classify pressure into four levels.

#### Scenario: Low memory pressure

- GIVEN memory usage is below 50% of the total limit
- WHEN memory pressure is calculated
- THEN the level is "low"
- AND full concurrency is allowed

#### Scenario: Medium memory pressure

- GIVEN memory usage is between 50% and 75% of the total limit
- WHEN memory pressure is calculated
- THEN the level is "medium"
- AND concurrency is reduced to 75%

#### Scenario: High memory pressure

- GIVEN memory usage is between 75% and 85% of the total limit
- WHEN memory pressure is calculated
- THEN the level is "high"
- AND concurrency is reduced to 50%
- AND cleanup is triggered

#### Scenario: Critical memory pressure

- GIVEN memory usage exceeds 85% of the total limit
- WHEN memory pressure is calculated
- THEN the level is "critical"
- AND concurrency is reduced to 20%
- AND forced cleanup is performed
- AND half the queued requests are dropped

### Requirement: Request Queue Processing

The system SHALL process resource requests through a priority queue with adaptive concurrency.

#### Scenario: Enqueue a new request

- GIVEN a resource URL and its type
- WHEN the request is enqueued
- THEN a unique request ID is generated
- AND the resource type and priority are determined from the URL
- AND duplicate requests are detected and served from cache

#### Scenario: Duplicate request detection

- GIVEN a request URL that has already been completed
- WHEN the same URL is enqueued again
- THEN the cached result is returned via the completion callback
- AND no new network request is made

#### Scenario: Concurrent request processing

- GIVEN the queue has multiple pending requests
- AND the adaptive concurrency limit allows N parallel requests
- WHEN the queue is processed
- THEN up to N requests are started simultaneously
- AND each request respects domain rate limits

#### Scenario: Request cancellation

- GIVEN an active or queued request
- WHEN a cancellation is requested
- THEN the request is aborted if active
- AND the request is removed from the queue if pending

### Requirement: CORS Fallback Strategy

The system SHALL attempt multiple fetch strategies when standard fetch fails for CSS, JS, or image resources.

#### Scenario: Standard fetch succeeds

- GIVEN a CSS, JS, or image resource URL
- WHEN the standard fetch succeeds
- THEN the response is returned directly

#### Scenario: Standard fetch fails, no-cors fallback

- GIVEN a CSS, JS, or image resource URL
- AND the standard fetch fails with a CORS error
- WHEN the no-cors fallback is attempted
- THEN the request is made with `mode: no-cors`
- AND an opaque response may be returned

#### Scenario: Standard and no-cors both fail, navigate fallback

- GIVEN a CSS, JS, or image resource URL
- AND both standard and no-cors fetches fail
- WHEN the navigate fallback is attempted
- THEN the request is made with `mode: navigate` and `cache: force-cache`
- AND the response is returned if successful

#### Scenario: All strategies fail

- GIVEN all fetch strategies fail for a resource
- WHEN the final attempt errors
- THEN the original error is thrown
- AND the request is marked as failed

### Requirement: Domain Rate Limiting

The system SHALL enforce per-domain rate limits to avoid overwhelming servers.

#### Scenario: Domain has available request slots

- GIVEN a domain with fewer than the maximum concurrent requests
- WHEN a new request for that domain is evaluated
- THEN the request is allowed to proceed

#### Scenario: Domain rate limit reached

- GIVEN a domain has reached its maximum concurrent requests
- WHEN a new request for that domain is evaluated
- THEN the request is deferred until a slot is available

#### Scenario: Rate limit adjustment on server response

- GIVEN a server responds with a 429 status code
- WHEN the rate limit is adjusted
- THEN the domain's request rate is reduced

#### Scenario: Rate limit recovery

- GIVEN a domain that was rate-limited
- WHEN subsequent requests succeed
- THEN the domain's request rate is gradually increased

### Requirement: Retry with Exponential Backoff

The system SHALL retry transiently failed requests with exponential backoff.

#### Scenario: Retryable error triggers retry

- GIVEN a request fails with a 5xx error, 408 timeout, 429 rate limit, or network error
- AND the retry count is below the maximum (3)
- WHEN the error is evaluated
- THEN the request is re-queued with exponential backoff delay

#### Scenario: Permanent error does not trigger retry

- GIVEN a request fails with a 4xx error (except 408 and 429)
- WHEN the error is evaluated
- THEN no retry is attempted
- AND the request is marked as permanently failed

#### Scenario: Maximum retries exceeded

- GIVEN a request has been retried the maximum number of times
- AND the request still fails
- WHEN the final retry fails
- THEN the request is marked as failed
- AND the error callback is invoked

### Requirement: Memory Allocation Tracking

The system SHALL track memory allocation for each resource request.

#### Scenario: Resource allocation tracking

- GIVEN a resource is being downloaded
- WHEN the resource size is known
- THEN the memory usage counter is incremented by the resource size
- AND the resource is marked as active

#### Scenario: Resource release on completion

- GIVEN a resource download completes
- WHEN the resource is released
- THEN the memory usage counter is decremented by the resource size
- AND the resource is moved from active to completed

#### Scenario: Resource failure cleanup

- GIVEN a resource download fails
- WHEN the failure is processed
- THEN the memory usage counter is decremented
- AND the resource is marked as failed

### Requirement: Memory Availability Check

The system SHALL check whether sufficient memory is available before processing a request.

#### Scenario: Sufficient memory available

- GIVEN the current memory usage plus the requested size is within the total memory limit
- WHEN memory availability is checked
- THEN the check returns true
- AND the request is allowed to proceed

#### Scenario: Insufficient memory

- GIVEN the current memory usage plus the requested size would exceed the total memory limit
- WHEN memory availability is checked
- THEN the check returns false
- AND the request is deferred

### Requirement: Adaptive Concurrency

The system SHALL adjust the number of concurrent requests based on memory pressure and network conditions.

#### Scenario: Full concurrency under low pressure

- GIVEN memory pressure is low
- WHEN the adaptive concurrency is calculated
- THEN the full configured concurrency limit is used

#### Scenario: Reduced concurrency under high pressure

- GIVEN memory pressure is high
- WHEN the adaptive concurrency is calculated
- THEN the concurrency is reduced to 50% of the configured limit
- AND the minimum concurrency is 2

#### Scenario: Minimal concurrency under critical pressure

- GIVEN memory pressure is critical
- WHEN the adaptive concurrency is calculated
- THEN the concurrency is reduced to 20% of the configured limit
- AND the minimum concurrency is 1

### Requirement: Periodic Memory Monitoring

The system SHALL perform periodic memory checks and garbage collection hints.

#### Scenario: Periodic memory check

- GIVEN a memory check interval of 5 seconds
- WHEN the interval fires
- THEN the memory pressure level is recalculated
- AND if pressure is high or above, old completed requests are cleaned up

#### Scenario: Garbage collection hint

- GIVEN a GC hint interval of 2 minutes
- WHEN the interval fires
- THEN garbage collection is suggested if the GC API is available

### Requirement: Resource Skipping

The system SHALL skip resources that exceed size limits.

#### Scenario: Resource exceeds per-type limit

- GIVEN a CSS resource of 8MB
- AND the CSS size limit is 5MB
- WHEN the resource is evaluated
- THEN the resource is skipped

#### Scenario: Resource exceeds global maximum

- GIVEN a resource of 60MB
- AND the global maximum resource size is 50MB
- WHEN the resource is evaluated
- THEN the resource is skipped regardless of type

#### Scenario: Resource within limits

- GIVEN an image resource of 15MB
- AND the image size limit is 20MB
- AND the global maximum is 50MB
- WHEN the resource is evaluated
- THEN the resource is not skipped
